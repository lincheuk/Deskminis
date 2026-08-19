/** D3 MCP stdio 传输客户端：spawn 子进程 + 换行分帧的 JSON-RPC（MCP stdio 规范）。
 *  本步只做传输与协议机械——initialize 握手、tools/list 翻页、tools/call、取消透传、
 *  启动/调用两级超时、崩溃拒绝；content[]/isError 的消化与权限接线在 D5。
 *  条目来自 McpServersStore.list() 的浅拷贝，嵌套 args/env 与 store 共享引用——全程只读，绝不原地改。 */
import { spawn, type ChildProcess } from 'node:child_process';
import { resolveEnvRefs } from './config';

export interface McpStdioOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** 握手整体超时（秒，默认 30）：超时杀子进程，不留半死连接 */
  startupTimeoutSeconds?: number;
  /** 单次 tools 请求超时（毫秒，默认 60000）：超时只失败该次调用，不杀连接 */
  callTimeoutMs?: number;
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpNotification {
  method: string;
  params?: unknown;
}

/** 「命令不存在」错误（spawn ENOENT 归一文案） */
export interface CommandNotFoundError extends Error {}

const PROTOCOL_VERSION = '2025-06-18';
const STARTUP_TIMEOUT_SECONDS_DEFAULT = 30;
const CALL_TIMEOUT_MS_DEFAULT = 60_000;
/** stderr 滚动保留的末尾长度：够定位崩溃原因即可，不无限吞日志 */
const STDERR_TAIL_LIMIT = 8192;
/** tools/list 翻页上限：防 server 侧 nextCursor 成环把客户端拖死 */
const LIST_PAGE_LIMIT = 10;

interface PendingEntry {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  /** 结算收尾：清超时定时器、摘 abort 监听（clearTimeout/removeEventListener 均幂等） */
  cleanup: () => void;
}

interface RequestOpts {
  timeoutMs: number;
  timeoutMessage: string;
  /** 超时附加动作——仅 initialize 用（杀子进程）；普通调用超时不迁怒连接 */
  onTimeout?: () => void;
  signal?: AbortSignal;
}

/**
 * spawn 策略（D5 替换 D3 的 .cmd 补试）：win32 且 command 为裸名（无路径分隔符）时经
 * cmd.exe /d /s /c 包裹启动——Node 对 *.cmd/.bat + shell:false 一律同步抛 EINVAL
 * （CVE-2024-27980 批处理护栏，与文件是否存在无关），而 npx/uvx 实为 .cmd 垫片，
 * 不包裹永远拉不起真 npx。cmd 元字符风险由信任面承担：命令来自用户自己的 servers.json
 * （同 Claude Desktop 模型；模型不能写这份配置）。非裸名或非 win32 → 原样 spawn。
 * ENOENT 归一「命令不存在」文案（不变）。platform/spawnImpl 作参数供非 Windows 机器单测。
 */
export function spawnMcpProcess(
  command: string,
  args: string[],
  opts: { cwd?: string; env: NodeJS.ProcessEnv },
  platform: string = process.platform,
  spawnImpl: typeof spawn = spawn,
): Promise<ChildProcess> {
  const bare = !command.includes('\\') && !command.includes('/');
  const viaCmd = platform === 'win32' && bare;
  return new Promise((resolve, reject) => {
    let settled = false; // spawn 成功后的迟到 'error'（如 EPIPE）交给 exit 事件收口，不重复结算
    const fail = (err: unknown): void => {
      if (settled) return;
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code === 'ENOENT') {
        const e = new Error(`命令不存在: ${command}。请确认已安装对应运行时或改用绝对路径`) as CommandNotFoundError;
        reject(e);
        return;
      }
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    let child: ChildProcess;
    try {
      // 包裹时也保持 shell:false——只是把命令行交给 cmd 解释，不经宿主 shell 二次展开
      child = viaCmd
        ? spawnImpl('cmd.exe', ['/d', '/s', '/c', command, ...args], { shell: false, cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'] })
        : spawnImpl(command, args, { shell: false, cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      // EINVAL 等同步 throw（批处理护栏），与 'error' 事件同路处理
      fail(err);
      return;
    }
    child.on('error', (err) => fail(err));
    child.on('spawn', () => {
      settled = true;
      resolve(child);
    });
  });
}

/**
 * 进程树终止（D5）：真 npx/uvx 会再拉 node 孙进程，只 kill 直子会留孤儿。
 * win32 用 taskkill /pid <pid> /T /F 尽力杀整树（spawn 失败/错误事件都吞掉——尽力而已），
 * 随后 child.kill() 兜底；其余平台 child.kill() 即可。spawnImpl 可注入供单测。
 */
export function killTree(
  child: ChildProcess,
  platform: string = process.platform,
  spawnImpl: typeof spawn = spawn,
): void {
  if (platform === 'win32' && typeof child.pid === 'number') {
    try {
      spawnImpl('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => {});
    } catch {
      // taskkill 不存在/不可用不该炸宿主，兜底还有 child.kill
    }
  }
  try { child.kill(); } catch { /* 已死进程的 kill 在个别平台会抛，吞掉 */ }
}

export class McpStdioClient {
  /** 服务器通知（无 id 消息）回调——未知通知也照发，消费哪些由 D5 决定（如 tools/list_changed） */
  onNotification: ((n: McpNotification) => void) | undefined;
  /** 子进程退出（自然退出或被杀）后为 true，此后一切请求立即以「进程已退出」拒绝 */
  closed = false;
  /** 被跳过的非 JSON stdout 行数——有些 server 把日志误打进 stdout，一行垃圾不能崩连接 */
  garbageLines = 0;

  private readonly command: string;
  private readonly args: string[];
  private readonly env: Record<string, string>;
  private readonly cwd: string | undefined;
  private readonly startupTimeoutMs: number;
  private readonly callTimeoutMs: number;
  private proc: ChildProcess | null = null;
  private disposed = false;
  private nextId = 0;
  private pending = new Map<number, PendingEntry>();
  /** stdout 半行缓冲：消息可能跨 chunk 断开，也可能一个 chunk 挤多条 */
  private outBuf = '';
  private stderrTailBuf = '';
  private exitError: Error | null = null;

  constructor(opts: McpStdioOptions) {
    this.command = opts.command;
    this.args = opts.args ?? [];
    this.env = opts.env ?? {};
    this.cwd = opts.cwd;
    this.startupTimeoutMs = (opts.startupTimeoutSeconds ?? STARTUP_TIMEOUT_SECONDS_DEFAULT) * 1000;
    this.callTimeoutMs = opts.callTimeoutMs ?? CALL_TIMEOUT_MS_DEFAULT;
  }

  /** 子进程退出码（未退出/从未 spawn 为 null）。Windows 上被 kill 的进程 exitCode 恒为
   *  null、只有 signalCode——判断「进程已终止」须二者任一非 null */
  get exitCode(): number | null {
    return this.proc?.exitCode ?? null;
  }

  get signalCode(): string | null {
    return this.proc?.signalCode ?? null;
  }

  /** stderr 滚动末尾（≤8KB）：只留诊断，不并入协议流、不打日志原文 */
  get stderrTail(): string {
    return this.stderrTailBuf;
  }

  async connect(): Promise<void> {
    // $$VAR 只在连接此刻解析——改了环境重连即生效；解析结果只进子进程环境，绝不回写配置。
    // 解析失败让 connect 直接拒绝（此时尚未 spawn，无孤儿进程）；错误文案由 helper 保证
    // 只含 $$引用名、不含任何已解析值，这里不重新拼值。
    const resolved: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.env)) resolved[k] = resolveEnvRefs(v);
    const child = await spawnMcpProcess(this.command, this.args, {
      cwd: this.cwd,
      env: { ...process.env, ...resolved },
    });
    this.proc = child;
    // 进程死后写 stdin 会抛 EPIPE——吞掉（生命周期统一由 exit 事件收口），否则未监听的 error 会崩宿主
    child.stdin?.on('error', () => {});
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (c: string) => this.feedStdout(c));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (c: string) => {
      this.stderrTailBuf = (this.stderrTailBuf + c).slice(-STDERR_TAIL_LIMIT);
    });
    child.on('exit', (code) => this.onExit(code));
    try {
      // 握手（等 initialize 应答 + 发 initialized）整体受启动超时约束
      await this.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'deskminis' },
      }, {
        timeoutMs: this.startupTimeoutMs,
        timeoutMessage: `MCP server 启动超时（${this.startupTimeoutMs / 1000} 秒）`,
        onTimeout: () => child.kill(),
      });
      this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    } catch (e) {
      // 握手失败（超时/进程退出）不留半死连接（kill 对已死进程是 no-op）
      child.kill();
      throw e;
    }
  }

  /** tools/list，跟随 nextCursor 翻页拼接；上限 10 页防环 */
  async listTools(): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < LIST_PAGE_LIMIT; page++) {
      const r = await this.request<{ tools?: McpToolInfo[]; nextCursor?: string }>(
        'tools/list',
        cursor === undefined ? undefined : { cursor },
        this.callRequestOpts(),
      );
      if (Array.isArray(r?.tools)) tools.push(...r.tools);
      cursor = r?.nextCursor;
      if (cursor === undefined) break;
    }
    return tools;
  }

  /** tools/call，返回原始 result——content[]/isError 的消化在 D5 */
  async callTool(name: string, args?: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<unknown> {
    return this.request('tools/call', { name, arguments: args ?? {} }, { ...this.callRequestOpts(), signal: opts?.signal });
  }

  /** 杀进程树（在途请求由 exit 事件统一拒绝）。真实 npx/uvx 会再拉 node 孙进程，
   *  只 kill 直子会留孤儿——win32 下 taskkill /T 整树杀（D5）。幂等。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.proc) killTree(this.proc);
  }

  private callRequestOpts(): RequestOpts {
    return {
      timeoutMs: this.callTimeoutMs,
      timeoutMessage: `MCP 工具调用超时（${this.callTimeoutMs / 1000} 秒）`,
    };
  }

  private request<T = unknown>(method: string, params: unknown, o: RequestOpts): Promise<T> {
    if (this.closed) return Promise.reject(this.exitError ?? new Error('MCP server 进程已退出'));
    const id = ++this.nextId; // 自增整数 id；响应按 id 配对
    return new Promise<T>((resolve, reject) => {
      let entry: PendingEntry;
      const timer = setTimeout(() => {
        // 先摘条目再拒绝：迟到的响应会按未知 id 丢弃（同 id 只结算一次）；
        // 是否杀进程由 onTimeout 决定（调用超时不杀连接）
        this.pending.delete(id);
        entry.cleanup();
        o.onTimeout?.();
        reject(new Error(o.timeoutMessage));
      }, o.timeoutMs);
      const onAbort = (): void => {
        if (!this.pending.has(id)) return; // 已被响应/超时结算，abort 迟到
        this.pending.delete(id);
        entry.cleanup();
        // 取消透传（A 波语义）：本地立即放弃等待，同时通知 server 别再算，不等其应答
        this.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'user' } });
        reject(new Error('已取消'));
      };
      entry = {
        resolve: (v) => {
          entry.cleanup();
          resolve(v as T);
        },
        reject: (e) => {
          entry.cleanup();
          reject(e);
        },
        cleanup: () => {
          clearTimeout(timer);
          o.signal?.removeEventListener('abort', onAbort);
        },
      };
      if (o.signal) {
        if (o.signal.aborted) {
          // 进来时就已中止：请求根本不发（还没有可取消的 requestId）
          entry.cleanup();
          reject(new Error('已取消'));
          return;
        }
        o.signal.addEventListener('abort', onAbort, { once: true });
      }
      this.pending.set(id, entry);
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  private feedStdout(chunk: string): void {
    this.outBuf += chunk;
    let nl: number;
    while ((nl = this.outBuf.indexOf('\n')) >= 0) {
      const line = this.outBuf.slice(0, nl).replace(/\r$/, ''); // 容忍 CRLF
      this.outBuf = this.outBuf.slice(nl + 1);
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    const t = line.trim();
    if (t === '') return;
    let msg: unknown;
    try {
      msg = JSON.parse(t);
    } catch {
      this.garbageLines++; // server 把日志误打到 stdout：跳过这行，连接照常
      return;
    }
    if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
      this.garbageLines++;
      return;
    }
    this.handleMessage(msg as Record<string, unknown>);
  }

  private handleMessage(msg: Record<string, unknown>): void {
    if ('result' in msg || 'error' in msg) {
      const id = msg.id;
      if (typeof id !== 'number') return; // 畸形响应：没有可配对的 id，丢弃
      const entry = this.pending.get(id);
      if (!entry) return; // 迟到响应（已超时/已取消）或未知 id：静默丢弃
      this.pending.delete(id);
      if ('error' in msg) {
        const err = msg.error as { message?: unknown } | null;
        entry.reject(new Error(typeof err?.message === 'string' ? err.message : 'MCP 服务器返回错误'));
      } else {
        entry.resolve(msg.result);
      }
      return;
    }
    if (typeof msg.method === 'string') {
      // 带 id 的 server→client 请求（sampling/roots 等）本层不支持——必须回 -32601，
      // 静默忽略会让对端挂着等应答直到它自身超时（D5 实测坑点）
      if (msg.id !== undefined) {
        this.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
        return;
      }
      // 无 id = 通知：一律转交回调（未知通知静默与否由消费方决定，本层不崩即可）
      this.onNotification?.({ method: msg.method, params: msg.params });
    }
  }

  private onExit(code: number | null): void {
    this.closed = true;
    this.exitError = new Error(`MCP server 进程已退出（code ${code ?? '未知'}）`);
    for (const entry of this.pending.values()) {
      entry.cleanup();
      entry.reject(this.exitError);
    }
    this.pending.clear();
  }

  private send(msg: unknown): void {
    const stdin = this.proc?.stdin;
    if (!stdin || stdin.destroyed) return;
    stdin.write(JSON.stringify(msg) + '\n');
  }
}
