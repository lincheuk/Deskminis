/** D5 MCP 管理器：把 D2 配置、D3 stdio、D4 http 串成 run 期能力。
 *  ensureForRun 时对 enabled server 并行连接 + listTools，工具以 mcp__<server>__<tool>
 *  直注册进 ToolRegistry（模型可见、可调用）；调用走权限类目 mcp（askOnce per server）；
 *  会话禁用在调用层硬执行（设计 §5.2：不是 run 快照，是每次调用现查）。
 *  生命周期：list_changed → stale 重列；崩溃（进程已退出/连接已关闭）→ error + 摘工具，
 *  下次 ensureForRun 单次驱逐重建；10 分钟空闲 → dispose + 摘工具回 idle。
 *  卫生：lastError 只放 client 层错误文案（不含 $$ 解析值/headers/env——client 层已保证）。 */
import { createHash } from 'node:crypto';
import type { McpServerEntry, McpServersStore } from './config';
import { McpStdioClient, type McpNotification, type McpToolInfo } from './stdio';
import { McpHttpClient } from './http';
import type { ToolRegistry } from '../tools/registry';
import type { ToolExecutor, ToolOutcome } from '../tools/types';
import type { ChatStore } from '../store/chat-store';

/** 与 McpStdioClient/McpHttpClient 同形的最小客户端面——测试注入假 client 用 */
export interface McpClientLike {
  connect(): Promise<void>;
  listTools(): Promise<McpToolInfo[]>;
  callTool(name: string, args?: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<unknown>;
  dispose(): void;
  onNotification: ((n: McpNotification) => void) | undefined;
  closed: boolean;
}

export interface McpManagerOptions {
  store: McpServersStore;
  chatStore: ChatStore;
  registry: ToolRegistry;
  /** 缺省真 client（按 transport 分派 stdio/http）；测试注入假 client */
  factories?: (entry: McpServerEntry) => McpClientLike;
}

export interface McpServerStatus {
  name: string;
  status: 'connected' | 'error' | 'idle';
  lastError?: string;
  toolCount: number;
  truncated: number;
}

interface ServerRuntime {
  client: McpClientLike | null;
  status: 'connected' | 'error' | 'idle';
  lastError?: string;
  /** 收到 tools/list_changed 后置位：下次 ensureForRun 在同一 client 上重新 listTools + 重注册 */
  stale: boolean;
  lastUsedAt: number;
  /** 该台当前在 registry 里的工具名（崩溃/驱逐/重列时整批摘除；也是 excludedToolNames 的数据源） */
  registeredNames: string[];
  truncated: number;
}

/** 空闲驱逐阈值：10 分钟无调用即 dispose（下次 ensureForRun 重连） */
const IDLE_EVICT_MS = 10 * 60_000;
const PER_SERVER_TOOL_LIMIT = 40;
const GLOBAL_TOOL_LIMIT = 120;
/** 工具全名 >64 时的截断形态：前 52 + '_' + sha256(原始全名) 前 12 hex = 恰 65 */
const NAME_LIMIT = 64;
const NAME_KEEP = 52;
/** 工具输出总量上限（码点）：防一条工具结果把上下文窗口整个吃掉 */
const OUTPUT_LIMIT_CP = 65_536;

/** 段内非法字符替换：模型侧工具名只许 [a-zA-Z0-9_-] */
function sanitizeSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** mcp__<server>__<tool> 全名：超长截断 + 哈希后缀（哈希输入是截断前的规范化全名，
 *  同一工具两次计算必然一致，重列前后名字稳定）。 */
function toolFullName(server: string, tool: string): string {
  const full = `mcp__${sanitizeSegment(server)}__${sanitizeSegment(tool)}`;
  if (full.length <= NAME_LIMIT) return full;
  const hash = createHash('sha256').update(full).digest('hex').slice(0, 12);
  return full.slice(0, NAME_KEEP) + '_' + hash;
}

/** tools/call 原始结果的消化：text 以换行拼接、非文本占位、isError 前缀、64K 码点截断。 */
function digestToolResult(result: unknown): ToolOutcome {
  const r = result as { content?: unknown; isError?: unknown } | null;
  const content = Array.isArray(r?.content) ? (r as { content: unknown[] }).content : [];
  const parts: string[] = [];
  for (const item of content) {
    const c = item as { type?: unknown; text?: unknown };
    if (c !== null && typeof c === 'object' && c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
    else parts.push(`[非文本内容：${String((c as { type?: unknown })?.type ?? '未知')}，暂不支持]`);
  }
  let out = parts.join('\n');
  const isError = (r as { isError?: unknown } | null)?.isError === true;
  if (isError) out = `MCP 工具报错: ${out}`;
  // Array.from 按码点切：按 UTF-16 unit 硬切会把 emoji 切成半个代理对（渲染成乱码）。
  // 截到「保留 + 注记 = 恰 64K 码点」，超限事实对用户可见。
  const cps = Array.from(out);
  if (cps.length > OUTPUT_LIMIT_CP) {
    const note = '\n[输出超 64K，已截断]';
    out = cps.slice(0, OUTPUT_LIMIT_CP - Array.from(note).length).join('') + note;
  }
  return { output: out, success: !isError };
}

export class McpManager {
  private readonly factories: (entry: McpServerEntry) => McpClientLike;
  private runtime = new Map<string, ServerRuntime>();

  constructor(private readonly opts: McpManagerOptions) {
    this.factories = opts.factories ?? defaultClientFactory;
    // 每分钟巡检空闲驱逐；unref：minisd 退出不被这个定时器拖住
    const timer = setInterval(() => this.checkIdleEvictions(), 60_000);
    timer.unref?.();
  }

  /** run 开始处调用：对每台 enabled 且未连接（或 stale）的 server 并行 connect + listTools。
   *  单台失败只记 error + 中文 lastError，不抛不阻塞其余台——MCP 是增强能力，坏一台不该毁整个 run。 */
  async ensureForRun(): Promise<void> {
    const enabled = this.opts.store.list().filter(e => e.enabled);
    // 阶段一并行连接/重列（结果暂存）；阶段二按 store 顺序注册——
    // 全局 120 上限的截断结果才确定性（谁先注册完谁占坑不能看网络谁快）。
    const listed = await Promise.all(enabled.map(async entry => {
      const rt = this.runtimeOf(entry.name);
      if (rt.client && rt.status === 'connected' && !rt.stale) return { entry, tools: null };
      if (!rt.client) {
        const client = this.factories(entry);
        client.onNotification = n => {
          // server 侧工具表变了：置 stale，下次 ensureForRun 重 list + 重注册
          if (n.method === 'tools/list_changed') rt.stale = true;
        };
        try {
          await client.connect();
        } catch (e) {
          rt.status = 'error';
          rt.lastError = e instanceof Error ? e.message : String(e);
          this.unregisterServer(entry.name);
          return { entry, tools: null };
        }
        rt.client = client;
        rt.lastError = undefined;
      }
      try {
        const tools = await rt.client!.listTools();
        return { entry, tools };
      } catch (e) {
        // list 失败（超时/中途退出）：连接作废，下次 ensureForRun 整台重来
        rt.status = 'error';
        rt.lastError = e instanceof Error ? e.message : String(e);
        rt.client!.dispose();
        rt.client = null;
        rt.stale = false;
        this.unregisterServer(entry.name);
        return { entry, tools: null };
      }
    }));
    for (const { entry, tools } of listed) {
      if (tools) this.registerServer(entry.name, tools);
    }
  }

  /** 全部 server 的运行态（含从未连接的 idle 台）；toolCount = 当前实际注册数 */
  statuses(): McpServerStatus[] {
    return this.opts.store.list().map(e => {
      const rt = this.runtime.get(e.name);
      if (!rt || rt.status === 'idle') return { name: e.name, status: 'idle' as const, toolCount: 0, truncated: 0 };
      if (rt.status === 'error') {
        return { name: e.name, status: 'error' as const, lastError: rt.lastError ?? '未知错误', toolCount: 0, truncated: 0 };
      }
      return { name: e.name, status: 'connected' as const, toolCount: rt.registeredNames.length, truncated: rt.truncated };
    });
  }

  /** 会话禁用台的全部工具名（run 开始并进 excludedToolNames——工具表剔除第一层，
   *  调用层硬执行是第二层，双保险）。禁用台从未连接过则无工具可剔除（它本来就不在表里）。 */
  excludedToolNames(sessionId: string): Set<string> {
    const disabled = new Set(this.opts.chatStore.getMcpDisabled(sessionId));
    const out = new Set<string>();
    if (disabled.size === 0) return out;
    for (const [name, rt] of this.runtime) {
      if (disabled.has(name)) for (const t of rt.registeredNames) out.add(t);
    }
    return out;
  }

  /** 空闲驱逐检查（抽成方法供单测直接调）：10 分钟无调用的连接台 dispose + 摘工具 + 回 idle。
   *  now 可注入；生产由构造里的 setInterval 每分钟调一次。 */
  checkIdleEvictions(now: number = Date.now()): void {
    for (const [name, rt] of [...this.runtime]) {
      if (!rt.client || rt.status !== 'connected') continue;
      if (now - rt.lastUsedAt >= IDLE_EVICT_MS) {
        rt.client.dispose();
        rt.client = null;
        this.unregisterServer(name);
        rt.status = 'idle';
        rt.stale = false;
      }
    }
  }

  /** minisd 退出收口：全部 dispose + 摘工具。幂等。 */
  disposeAll(): void {
    for (const [name, rt] of [...this.runtime]) {
      rt.client?.dispose();
      rt.client = null;
      this.unregisterServer(name);
      rt.status = 'idle';
      rt.stale = false;
    }
  }

  private runtimeOf(name: string): ServerRuntime {
    let rt = this.runtime.get(name);
    if (!rt) {
      rt = { client: null, status: 'idle', stale: false, lastUsedAt: 0, registeredNames: [], truncated: 0 };
      this.runtime.set(name, rt);
    }
    return rt;
  }

  /** 注册一台的工具：先整批摘旧名（stale 重列/重连重建），再按返回序注册。
   *  撞名（规范化后同名，含跨台）跳过并计入 truncated；每台 40、全局 120 封顶。 */
  private registerServer(server: string, tools: McpToolInfo[]): void {
    const rt = this.runtimeOf(server);
    this.unregisterServer(server);
    rt.status = 'connected';
    rt.lastError = undefined;
    rt.lastUsedAt = Date.now();
    // 撞名判定用 registry 现存全名（含别台 MCP 工具与内置工具——谁先注册谁占坑）
    const existing = new Set(this.opts.registry.definitions().map(d => d.name));
    let mcpCount = 0;
    for (const r of this.runtime.values()) mcpCount += r.registeredNames.length;
    const registered: string[] = [];
    let truncated = 0;
    for (const t of tools) {
      if (registered.length >= PER_SERVER_TOOL_LIMIT || mcpCount >= GLOBAL_TOOL_LIMIT) { truncated++; continue; }
      const name = toolFullName(server, t.name);
      if (existing.has(name)) { truncated++; continue; } // 规范化撞名：注册者跳过
      existing.add(name);
      this.opts.registry.register(this.mkExecutor(server, t, name));
      registered.push(name);
      mcpCount++;
    }
    rt.registeredNames = registered;
    rt.truncated = truncated;
    rt.stale = false;
  }

  /** 摘一台的全部工具（崩溃/驱逐/重连重建时）；全局计数随 registeredNames 清空自然回收 */
  private unregisterServer(name: string): void {
    const rt = this.runtime.get(name);
    if (!rt) return;
    for (const n of rt.registeredNames) this.opts.registry.unregister(n);
    rt.registeredNames = [];
    rt.truncated = 0;
  }

  /** 调用中发现该台已废（崩溃/关闭）：error + 摘工具 + dispose，下次 ensureForRun 重连 */
  private markServerError(name: string, msg: string): void {
    const rt = this.runtime.get(name);
    if (!rt) return;
    rt.client?.dispose();
    rt.client = null;
    rt.status = 'error';
    rt.lastError = msg;
    rt.stale = false;
    this.unregisterServer(name);
  }

  /** 每个 MCP 工具一个 ToolExecutor：definition 平铺层只给 tool_title（兼容旧审计/预检路径），
   *  原始 inputSchema 原样放 rawInputSchema 由 provider 侧直用。 */
  private mkExecutor(server: string, info: McpToolInfo, name: string): ToolExecutor {
    return {
      definition: {
        name,
        description: info.description ?? '',
        parameters: {
          tool_title: { type: 'string', description: '这次调用的 5-10 字中文摘要，用于 UI 卡片' },
        },
        required: ['tool_title'], // MCP 侧真实必填由 rawInputSchema.required 表达
        rawInputSchema: info.inputSchema,
      },
      execute: async (input, ctx): Promise<ToolOutcome> => {
        if (ctx.signal?.aborted) return { output: '[已取消]', success: false };
        // 会话禁用硬执行：现查而非 run 快照——run 开始后用户仍可关掉这台（§5.2 修坑点）
        if (this.opts.chatStore.getMcpDisabled(ctx.sessionId).includes(server)) {
          return { output: '该 MCP server 已在本会话禁用', success: false };
        }
        const decision = await ctx.permissions.check({
          kind: 'mcp', detail: server, sessionId: ctx.sessionId, toolTitle: String(input.tool_title ?? ''),
        });
        // 闸后重查取消（A 波语义）：等审批期间用户可能点了停止
        if (ctx.signal?.aborted) return { output: '[已取消]', success: false };
        if (decision === 'deny') return { output: 'MCP 调用被用户拒绝（可在设置-权限中调整）', success: false };
        const rt = this.runtime.get(server);
        if (!rt?.client) {
          // 工具已在表里但连接先没了（驱逐竞态）：按已废处理，下一次调用前 ensureForRun 会重建
          this.markServerError(server, 'MCP server 连接已不可用');
          return { output: 'MCP server 连接已不可用', success: false };
        }
        rt.lastUsedAt = Date.now();
        const { tool_title: _drop, ...args } = input;
        try {
          const result = await rt.client.callTool(info.name, args, { signal: ctx.signal });
          return digestToolResult(result);
        } catch (e) {
          // 「进程已退出/连接已关闭」类错误：该台已废，标记 error + 摘工具，下次 ensureForRun 重连；
          // 其余错误（超时/取消）只失败本次调用。透传抛出由 registry 兜底成失败 outcome 喂给模型。
          const msg = e instanceof Error ? e.message : String(e);
          if (rt.client.closed || msg.includes('已退出') || msg.includes('连接已关闭')) this.markServerError(server, msg);
          throw e;
        }
      },
    };
  }
}

/** 缺省工厂：按 transport 分派真 client（stdio 子进程 / streamable-http） */
function defaultClientFactory(entry: McpServerEntry): McpClientLike {
  if (entry.transport === 'stdio') {
    return new McpStdioClient({
      command: entry.command ?? '',
      args: entry.args,
      env: entry.env,
      cwd: entry.cwd,
      startupTimeoutSeconds: entry.startupTimeoutSeconds,
    });
  }
  return new McpHttpClient({
    url: entry.url ?? '',
    headers: entry.headers,
    startupTimeoutSeconds: entry.startupTimeoutSeconds,
  });
}
