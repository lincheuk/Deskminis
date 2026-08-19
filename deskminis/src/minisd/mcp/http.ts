/** D4 MCP streamable-http 传输客户端：每条 JSON-RPC 一次 POST（MCP streamable-http 规范）。
 *  本步只做传输与协议机械——initialize 握手（Mcp-Session-Id 捕获/回显）、JSON/SSE 双形态
 *  响应分派、tools/list 翻页、tools/call 两级超时与取消透传、dispose 收口；content[]/isError
 *  的消化与权限接线在 D5。GET 长流通知监听、OAuth、自动重连本波不做（驱逐重建在 D5）。 */
import { resolveEnvRefs } from './config';
import type { McpNotification, McpToolInfo } from './stdio';

export interface McpHttpClientOptions {
  url: string;
  /** 鉴权/自定义头：值里的 $$NAME 每次请求时解析——改环境即刻生效，无需重建客户端 */
  headers?: Record<string, string>;
  /** 握手整体超时（秒，默认 30） */
  startupTimeoutSeconds?: number;
  /** 单次 tools 请求超时（毫秒，默认 60000）：超时只失败该次调用，不报废连接 */
  callTimeoutMs?: number;
}

const PROTOCOL_VERSION = '2025-06-18';
const STARTUP_TIMEOUT_SECONDS_DEFAULT = 30;
const CALL_TIMEOUT_MS_DEFAULT = 60_000;
/** tools/list 翻页上限：防 server 侧 nextCursor 成环把客户端拖死（同 D3） */
const LIST_PAGE_LIMIT = 10;

/** 非 2xx 一律不读响应体进文案——错误页可能回显请求头里的 token（D1 密钥卫生同款） */
function httpStatusError(status: number): Error {
  if (status === 401 || status === 403) {
    return new Error(`认证失败或无权限（HTTP ${status}），请检查 headers 配置`);
  }
  return new Error(`MCP 服务器错误（HTTP ${status}）`);
}

/** JSON-RPC error 对象 → Error：透传 message，无 message 用兜底文案（同 D3） */
function rpcError(msg: Record<string, unknown>): Error {
  const err = msg.error as { message?: unknown } | null;
  return new Error(typeof err?.message === 'string' ? err.message : 'MCP 服务器返回错误');
}

interface RequestOpts {
  timeoutMs: number;
  timeoutMessage: string;
  signal?: AbortSignal;
}

export class McpHttpClient {
  /** 服务器通知（无 id 消息）回调——SSE 响应流里的通知也走这里，消费哪些由 D5 决定 */
  onNotification: ((n: McpNotification) => void) | undefined;
  /** dispose 后为 true，此后一切请求立即以「连接已关闭」拒绝 */
  closed = false;
  /** SSE 流里被跳过的坏消息数（非 JSON data 行、与本请求无关的消息）——垃圾不能崩连接 */
  garbageEvents = 0;

  private readonly url: string;
  private readonly cfgHeaders: Record<string, string>;
  private readonly startupTimeoutMs: number;
  private readonly callTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private sessionId: string | null = null;
  private disposed = false;
  private nextId = 0;
  /** dispose 的总闸：中止全部在途 fetch（DELETE 告别请求单独走，不挂此信号） */
  private disposeController = new AbortController();

  constructor(opts: McpHttpClientOptions, fetchImpl: typeof fetch = fetch) {
    this.url = opts.url;
    this.cfgHeaders = opts.headers ?? {};
    this.startupTimeoutMs = (opts.startupTimeoutSeconds ?? STARTUP_TIMEOUT_SECONDS_DEFAULT) * 1000;
    this.callTimeoutMs = opts.callTimeoutMs ?? CALL_TIMEOUT_MS_DEFAULT;
    this.fetchImpl = fetchImpl;
  }

  /** 握手：initialize 应答里可能带 Mcp-Session-Id（Headers.get 天然大小写不敏感），此后回显；
   *  initialized 通知属 fire-and-forget——响应体忽略、任何失败不影响握手结果，
   *  但等它落地再返回 connect，保证调用方后续请求一定排在 initialized 之后。 */
  async connect(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'deskminis' },
    }, {
      timeoutMs: this.startupTimeoutMs,
      timeoutMessage: `MCP server 启动超时（${this.startupTimeoutMs / 1000} 秒）`,
    });
    await this.notify('notifications/initialized', undefined, this.startupTimeoutMs).catch(() => {});
  }

  /** tools/list，跟随 nextCursor 翻页拼接；上限 10 页防环 */
  async listTools(): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < LIST_PAGE_LIMIT; page++) {
      const r = await this.request<{ tools?: McpToolInfo[]; nextCursor?: string }>(
        'tools/list',
        cursor === undefined ? undefined : { cursor },
        this.callOpts(),
      );
      if (Array.isArray(r?.tools)) tools.push(...r.tools);
      cursor = r?.nextCursor;
      if (cursor === undefined) break;
    }
    return tools;
  }

  /** tools/call，返回原始 result——content[]/isError 的消化在 D5 */
  async callTool(name: string, args?: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<unknown> {
    return this.request('tools/call', { name, arguments: args ?? {} }, { ...this.callOpts(), signal: opts?.signal });
  }

  /** 中止全部在途请求；有会话则尽力 DELETE 告别（失败静默）；幂等 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.closed = true;
    this.disposeController.abort();
    if (this.sessionId !== null) {
      // 告别请求不挂 dispose 信号（否则发出瞬间即自灭），只给超时兜底
      void this.fetchImpl(this.url, {
        method: 'DELETE',
        headers: { 'mcp-session-id': this.sessionId },
        signal: AbortSignal.timeout(this.callTimeoutMs),
      }).catch(() => {});
    }
  }

  private callOpts(): RequestOpts {
    return {
      timeoutMs: this.callTimeoutMs,
      timeoutMessage: `MCP 工具调用超时（${this.callTimeoutMs / 1000} 秒）`,
    };
  }

  /** 每请求现拼请求头：两个协议头 + 会话回显 + 配置头（值过 resolveEnvRefs，未设置的
   *  $$NAME 让本次请求直接拒绝；错误文案由 helper 保证只含 $$名、不含任何已解析值） */
  private buildHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (this.sessionId !== null) h['mcp-session-id'] = this.sessionId;
    for (const [k, v] of Object.entries(this.cfgHeaders)) h[k] = resolveEnvRefs(v);
    return h;
  }

  /** 通知类 POST（无 id、不等有意义的应答）：2xx/202 即可、响应体忽略，失败由调用方静默吞掉 */
  private notify(method: string, params: unknown, timeoutMs: number): Promise<void> {
    if (this.closed) return Promise.resolve();
    let headers: Record<string, string>;
    try {
      headers = this.buildHeaders();
    } catch (e) {
      return Promise.reject(e);
    }
    return this.fetchImpl(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', method, params }),
      signal: AbortSignal.any([this.disposeController.signal, AbortSignal.timeout(timeoutMs)]),
    }).then((r) => {
      // 体不读；主动取消流，避免连接挂着半截响应
      r.body?.cancel().catch(() => {});
    });
  }

  /** 单条 JSON-RPC 一次 POST。三个中止源（超时/调用方/dispose）都挂监听本地结算——
   *  不依赖 fetch 是否规守地传播 abort，mock 与真实现行为一致。 */
  private request<T = unknown>(method: string, params: unknown, o: RequestOpts): Promise<T> {
    if (this.closed) return Promise.reject(new Error('连接已关闭'));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      let headers: Record<string, string>;
      try {
        headers = this.buildHeaders();
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      let settled = false;
      const timeoutSignal = AbortSignal.timeout(o.timeoutMs);
      const cleanup = (): void => {
        timeoutSignal.removeEventListener('abort', onTimeout);
        this.disposeController.signal.removeEventListener('abort', onDispose);
        o.signal?.removeEventListener('abort', onAbort);
      };
      const finish = (settle: () => void): void => {
        if (settled) return; // 同一请求只结算一次（如 abort 后 fetch 才拒绝）
        settled = true;
        cleanup();
        settle();
      };
      const onTimeout = (): void => finish(() => reject(new Error(o.timeoutMessage)));
      const onDispose = (): void => finish(() => reject(new Error('连接已关闭')));
      const onAbort = (): void => {
        // 本地立即放弃等待，同时尽力通知 server 别再算（fire-and-forget，失败静默）
        finish(() => reject(new Error('已取消')));
        void this.notify('notifications/cancelled', { requestId: id, reason: 'user' }, this.callTimeoutMs)
          .catch(() => {});
      };
      timeoutSignal.addEventListener('abort', onTimeout, { once: true });
      this.disposeController.signal.addEventListener('abort', onDispose, { once: true });
      if (o.signal) {
        if (o.signal.aborted) {
          // 进来时就已中止：请求根本不发（还没有可取消的 requestId）
          onAbort();
          return;
        }
        o.signal.addEventListener('abort', onAbort, { once: true });
      }
      void (async () => {
        try {
          const combined = AbortSignal.any([timeoutSignal, this.disposeController.signal, ...(o.signal ? [o.signal] : [])]);
          const res = await this.fetchImpl(this.url, {
            method: 'POST',
            headers,
            body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
            signal: combined,
          });
          if (!res.ok) {
            finish(() => reject(httpStatusError(res.status)));
            return;
          }
          // 任何 2xx 响应都可能携带会话头（服务器中途换发也照收）
          const sid = res.headers.get('mcp-session-id');
          if (sid) this.sessionId = sid;
          const ct = res.headers.get('content-type') ?? '';
          const text = await res.text();
          if (ct.includes('text/event-stream')) {
            this.consumeSse(text, id, finish, resolve, reject);
            return;
          }
          // application/json（及其余形态按 JSON 尝试）：整体解析为单条应答
          let msg: unknown;
          try {
            msg = JSON.parse(text);
          } catch {
            finish(() => reject(new Error('MCP 服务器响应无法解析')));
            return;
          }
          this.settleJson(msg, id, finish, resolve, reject);
        } catch (e) {
          // 走到这里必是 fetch/读体被中止或网络异常；各中止源已有监听本地结算，
          // 未结算的只剩真网络异常
          finish(() => reject(new Error(`MCP 服务器连接失败: ${e instanceof Error ? e.message : String(e)}`)));
        }
      })();
    });
  }

  /** SSE 形态：逐行只认 data: 行；带匹配 id 的是本请求应答、带 method 无 id 的转通知回调、
   *  其余（解析失败/无关消息）计数跳过。流读完仍没等到应答 → 无法解析。 */
  private consumeSse<T>(
    text: string,
    id: number,
    finish: (settle: () => void) => void,
    resolve: (v: T) => void,
    reject: (e: Error) => void,
  ): void {
    let answered = false;
    for (const raw of text.split('\n')) {
      const line = raw.replace(/\r$/, ''); // 容忍 CRLF
      if (!line.startsWith('data:')) continue; // event:/id:/注释/空行一概不认
      const payload = line.slice(5).replace(/^ /, ''); // SSE 只剥一个前导空格
      let msg: unknown;
      try {
        msg = JSON.parse(payload);
      } catch {
        this.garbageEvents++;
        continue;
      }
      if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
        this.garbageEvents++;
        continue;
      }
      const m = msg as Record<string, unknown>;
      if (('result' in m || 'error' in m) && m.id === id) {
        answered = true;
        finish(() => {
          if ('error' in m) reject(rpcError(m));
          else resolve(m.result as T);
        });
        continue; // 应答之后流里可能还有通知，继续消化
      }
      if (typeof m.method === 'string' && m.id === undefined) {
        this.onNotification?.({ method: m.method, params: m.params });
        continue;
      }
      this.garbageEvents++; // 无关消息（他人应答/server→client 请求等）
    }
    if (!answered) finish(() => reject(new Error('MCP 服务器响应无法解析')));
  }

  /** JSON 形态的分派：与 SSE 单条消息同一套判定 */
  private settleJson<T>(
    msg: unknown,
    id: number,
    finish: (settle: () => void) => void,
    resolve: (v: T) => void,
    reject: (e: Error) => void,
  ): void {
    if (typeof msg === 'object' && msg !== null && !Array.isArray(msg)) {
      const m = msg as Record<string, unknown>;
      if ('result' in m || 'error' in m) {
        finish(() => {
          if ('error' in m) reject(rpcError(m));
          else resolve(m.result as T);
        });
        return;
      }
      if (typeof m.method === 'string' && m.id === undefined) {
        this.onNotification?.({ method: m.method, params: m.params });
      }
    }
    // 到这里说明响应体不是可配对的本请求应答
    finish(() => reject(new Error('MCP 服务器响应无法解析')));
  }
}
