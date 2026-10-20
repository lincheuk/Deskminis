/**
 * F13 测试夹具（不是测试文件）。
 *
 * 运行时不引入 F13 的新模块（shared/permission、tools/permission-*）：对它们只有 import type。
 * 这样先红用例（permission-callers / permission-bridge / permission-minisd）在实现之前就能加载、红在行为上；
 * 实现之后同一份用例文本转绿。需要真实 broker 的夹具在 permission-stack-fixture.ts。
 *
 * 受控延迟只有两种：挂起的询问函数 / 权限卡（测试决定何时答复），和很短的真实时限（只断言结果，不断言时长）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import WebSocket from 'ws';
import { MinisPaths } from '../src/minisd/paths';
import { ToolRegistry } from '../src/minisd/tools/registry';
import { fileReadTool, fileWriteTool, fileEditTool } from '../src/minisd/tools/files';
import { officeReadTool, officeWriteTool } from '../src/minisd/tools/office';
import { fileListTool, fileGlobTool, fileGrepTool } from '../src/minisd/tools/search';
import { makeShellTool, ShellManager } from '../src/minisd/tools/shell';
import { makeWebFetchTool } from '../src/minisd/tools/web';
import { makeWebSearchTool, type ResolvedSearchProvider } from '../src/minisd/tools/web-search';
import { McpManager, type McpClientLike } from '../src/minisd/mcp/manager';
import { McpServersStore } from '../src/minisd/mcp/config';
import type { McpNotification, McpToolInfo } from '../src/minisd/mcp/stdio';
import { ChatStore } from '../src/minisd/store/chat-store';
import { openDb } from '../src/minisd/store/db';
import { CheckpointStore } from '../src/minisd/checkpoints/store';
import { makeBridgeDispatcher, type BridgeEnvelope, type BridgeRequest } from '../src/minisd/bridge/handlers';
import { startMinisd, type StartMinisdOpts } from '../src/minisd/index';
import type { PermissionDecision, PermissionGateway, PermissionRequest, ToolContext } from '../src/minisd/tools/types';
import type { PermissionDenied } from '../src/shared/permission';

// ---------- 网关替身 ----------

/** 询问时带的选项（PermissionAskOptions 的结构副本：夹具不依赖它在 base 上是否已存在）。 */
export interface AskOptsSeen { toolUseId?: string; signal?: AbortSignal; origin?: 'tool' | 'bridge'; onIssued?(requestId: string): void }
export interface NotedDenial { req: PermissionRequest; denied: PermissionDenied; opts?: { toolUseId?: string; origin?: 'tool' | 'bridge' } }

export interface OutcomeGateway extends PermissionGateway {
  /** decide 收到的每个请求，按到达序。 */
  asked: PermissionRequest[];
  askedOpts: (AskOptsSeen | undefined)[];
  /** noteDenied 收到的每一条。 */
  noted: NotedDenial[];
}

/**
 * 带 decide 的网关替身：fn 返回什么，decide 就原样交回什么（可以是垃圾值——调用方必须自己失败关闭）。
 * 模拟「弹过卡」的结果时字面量里带 requestId，如 { decision: 'allow', via: 'user-once', requestId: 'CARD-1' }。
 * check 是 decide 的二值投影（base 上的工具只会调它）。
 */
export function outcomeGateway(fn: (req: PermissionRequest, opts?: AskOptsSeen) => unknown): OutcomeGateway {
  const gw = {
    asked: [] as PermissionRequest[],
    askedOpts: [] as (AskOptsSeen | undefined)[],
    noted: [] as NotedDenial[],
    async decide(req: PermissionRequest, opts?: AskOptsSeen): Promise<never> {
      gw.asked.push(req); gw.askedOpts.push(opts);
      return (await fn(req, opts)) as never;
    },
    async check(req: PermissionRequest): Promise<PermissionDecision> {
      const o = (await gw.decide(req)) as { decision?: unknown } | undefined;
      return o !== null && typeof o === 'object' && o.decision === 'allow' ? 'allow' : 'deny';
    },
    noteDenied(req: PermissionRequest, denied: PermissionDenied, opts?: NotedDenial['opts']): void { gw.noted.push({ req, denied, opts }); },
    hasBridgeGrant: (): boolean => false,
  };
  return gw as unknown as OutcomeGateway;
}

/** 旧式二值网关：只有 check。d 可以是任意值（验「不是恰好 'allow' 就拒」）。 */
export function binaryGateway(d: unknown): PermissionGateway & { asked: PermissionRequest[] } {
  const asked: PermissionRequest[] = [];
  return { asked, async check(req) { asked.push(req); return d as PermissionDecision; }, hasBridgeGrant: () => false };
}

/** 旧式询问函数：返回手动兑现的 Promise，不理会网关给的控制参数。 */
export function heldPrompt(): {
  prompt: (req: PermissionRequest) => Promise<'allow-once' | 'allow-session' | 'deny'>;
  calls: PermissionRequest[];
  /** 兑现最早一个还挂着的询问。 */
  answer(d: 'allow-once' | 'allow-session' | 'deny'): void;
  untilCalled(n: number, timeoutMs?: number): Promise<void>;
} {
  const calls: PermissionRequest[] = [];
  const pending: ((d: 'allow-once' | 'allow-session' | 'deny') => void)[] = [];
  let waiters: { n: number; resolve: () => void }[] = [];
  return {
    calls,
    prompt: req => new Promise(resolve => {
      calls.push(req); pending.push(resolve);
      for (const w of waiters.filter(x => calls.length >= x.n)) w.resolve();
      waiters = waiters.filter(x => calls.length < x.n);
    }),
    answer(d) {
      const r = pending.shift();
      if (!r) throw new Error('没有挂着的权限询问');
      r(d);
    },
    untilCalled(n, timeoutMs = 3000) {
      if (calls.length >= n) return Promise.resolve();
      return withDeadline(new Promise<void>(resolve => { waiters.push({ n, resolve }); }), timeoutMs, `询问函数第 ${n} 次被调（当前 ${calls.length} 次）`);
    },
  };
}

/** 形状不合法的权限结果：任何一个都不能被当成放行。 */
export const JUNK_OUTCOMES: { label: string; value: unknown }[] = [
  { label: 'undefined', value: undefined },
  { label: 'null', value: null },
  { label: "字符串 'allow'", value: 'allow' },
  { label: "字符串 'allow-once'", value: 'allow-once' },
  { label: "字符串 'ALLOW'", value: 'ALLOW' },
  { label: 'true', value: true },
  { label: '1', value: 1 },
  { label: '{}', value: {} },
  { label: '[]', value: [] },
  { label: '缺 via 的 allow', value: { decision: 'allow' } },
  { label: 'via 不认识的 allow', value: { decision: 'allow', via: 'whatever' } },
  { label: "decision 大小写不对", value: { decision: 'Allow', via: 'user-once' } },
  { label: '缺 reason 的 deny', value: { decision: 'deny' } },
  { label: 'reason 不认识的 deny', value: { decision: 'deny', reason: 'nope' } },
  { label: '取 decision 时抛错的对象', value: Object.defineProperty({}, 'decision', { get() { throw new Error('注入：读 decision 抛错'); }, enumerable: true }) },
];

// ---------- 通用等待 ----------

export function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`等待超时: ${what}`)), ms); });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

export async function waitFor(what: string, cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise(r => setTimeout(r, 10));
  }
}

/** 让出事件循环几轮（微任务与 setImmediate 都跑到）。只用来等「同步链上的续体」跑完，不用来排顺序。 */
export async function settle(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>(r => setImmediate(r));
}

// ---------- 调用方夹具：12 个工具入口 + 桥分发器 ----------

export const TOOL_CALLERS = [
  'file_read', 'file_write', 'file_edit', 'office_read', 'office_write',
  'file_list', 'file_glob', 'file_grep', 'shell_execute', 'web_fetch', 'web_search', 'mcp__a__echo',
] as const;
export type ToolCaller = (typeof TOOL_CALLERS)[number];
export const CALLERS = [...TOOL_CALLERS, 'bridge'] as const;
export type Caller = (typeof CALLERS)[number];

/** 每个调用方「走卡」的入参：不批准就没有任何副作用，批准后副作用可数。 */
const MARKER = 'F13-MARKER-正文';
const DOC_MARKER = 'F13-DOC-正文';
const INPUTS: Record<ToolCaller, Record<string, unknown>> = {
  file_read: { path: '/var/minis/mcp-servers/servers.json', tool_title: '读配置' },
  file_write: { path: '/var/minis/skills/f13/a.md', content: 'NEW', tool_title: '写技能' },
  file_edit: { path: '/var/minis/skills/f13/e.md', old_string: 'OLD', new_string: 'NEW', tool_title: '改技能' },
  office_read: { path: '/var/minis/mcp-servers/a.docx', tool_title: '读文档' },
  office_write: { path: '/var/minis/skills/f13/a.docx', content: JSON.stringify({ blocks: [{ kind: 'para', text: 'x' }] }), tool_title: '写文档' },
  file_list: { path: '/var/minis/mcp-servers', tool_title: '列目录' },
  file_glob: { pattern: '*.json', path: '/var/minis/mcp-servers', tool_title: '找文件' },
  file_grep: { pattern: MARKER, path: '/var/minis/mcp-servers', tool_title: '搜文本' },
  shell_execute: { command: 'npm install left-pad', tool_title: '装包' },
  web_fetch: { url: 'https://example.com/f13', tool_title: '抓网页' },
  web_search: { query: 'f13 关键词', tool_title: '搜网络' },
  mcp__a__echo: { tool_title: '调 MCP' },
};

export interface CallerResult {
  /** 工具的 output；桥是信封的 error.message（成功时为空串）。 */
  output: string; success: boolean;
  /** 这次调用产生的副作用次数（读到内容 / 落盘 / 起进程 / 出网 / 发 MCP 调用 / 跑 PowerShell）。 */
  effects: number;
  /** 仅桥：信封的 error.code 与 error.reason。 */
  code?: string; reason?: string;
}

class CountingMcpClient implements McpClientLike {
  onNotification: ((n: McpNotification) => void) | undefined;
  closed = false;
  callLog: { name: string; args: Record<string, unknown> | undefined }[] = [];
  async connect(): Promise<void> { /* 假连接 */ }
  async listTools(): Promise<McpToolInfo[]> { return [{ name: 'echo', description: '回声', inputSchema: { type: 'object', properties: {} } }]; }
  async callTool(name: string, args?: Record<string, unknown>): Promise<unknown> {
    this.callLog.push({ name, args });
    return { content: [{ type: 'text', text: 'mcp ok' }] };
  }
  dispose(): void { this.closed = true; }
}

export interface CallerHarness {
  root: string; sid: string; paths: MinisPaths; chat: ChatStore; registry: ToolRegistry;
  mcpStore: McpServersStore; mcp: McpManager; mcpClients: CountingMcpClient[];
  /** MCP 配置文件（servers.json）的宿主路径：测试手改它来模拟「没经过 RPC 的配置变更」。 */
  mcpConfigFile: string;
  /** web_search 读的搜索配置（测试可改）。 */
  search: { conf: ResolvedSearchProvider | undefined };
  /** 出网次数（web_fetch 与 web_search 共用的假 fetch）。 */
  fetchCalls: string[];
  spawned: unknown[][];
  psCalls: string[];
  abs(guest: string): string;
  /** 夹具自己的库（F08：检查点探针读 file_checkpoints 的行数）。 */
  db: Database.Database;
  /** F08：callerHarness({ checkpoints: true }) 时是接在这个库上的真实存储，内容目录在 <root>/checkpoints；否则没有。 */
  checkpoints?: CheckpointStore;
  run(caller: Caller, gateway: PermissionGateway, opts?: { signal?: AbortSignal; input?: Record<string, unknown>; bridgeCtl?: { signal?: AbortSignal } }): Promise<CallerResult>;
  dispose(): void;
}

/** 临时数据根 + 真实工具，副作用全部可数。每次 run 之前把写入目标复位。
 *  opts.checkpoints（F08）：为真时给工具上下文接一个真实的检查点存储（建在夹具自己的库与 <root>/checkpoints 上），
 *  「权限询问之前零副作用」的探针才测得到检查点；不传时上下文与以前逐字段相同。 */
export async function callerHarness(opts: { checkpoints?: boolean } = {}): Promise<CallerHarness> {
  const root = mkdtempSync(join(tmpdir(), 'dm-f13-callers-'));
  const paths = new MinisPaths(root);
  const db = openDb(':memory:');
  const chat = new ChatStore(db);
  const checkpoints = opts.checkpoints ? new CheckpointStore(db, join(root, 'checkpoints'), { warn: () => undefined }) : undefined;
  const sid = chat.createSession().id;
  paths.ensureSessionDirs(sid);
  const abs = (guest: string): string => paths.resolveGuestPath(sid, guest);

  const fetchCalls: string[] = [];
  const fakeFetch = (async (url: unknown) => {
    fetchCalls.push(String(url));
    return String(url).includes('example.com')
      ? new Response('hello f13', { status: 200, headers: { 'content-type': 'text/plain' } })
      : new Response(JSON.stringify({ web: { results: [] }, results: [] }), { status: 200 });
  }) as unknown as typeof fetch;
  const search: { conf: ResolvedSearchProvider | undefined } = { conf: { kind: 'brave', apiKey: 'KEY-1' } };

  const spawned: unknown[][] = [];
  const fakeSpawn = ((...args: unknown[]) => { spawned.push(args); throw new Error('夹具：不真的起 shell'); }) as unknown as typeof spawn;

  const registry = new ToolRegistry();
  for (const t of [fileReadTool, fileWriteTool, fileEditTool, officeReadTool, officeWriteTool, fileListTool, fileGlobTool, fileGrepTool]) registry.register(t);
  registry.register(makeShellTool(new ShellManager({ spawnImpl: fakeSpawn })));
  registry.register(makeWebFetchTool(fakeFetch));
  registry.register(makeWebSearchTool(() => search.conf, fakeFetch));

  // MCP 的配置放在另一个临时根里：本数据根的 mcp-servers/servers.json 留作「要问才能读」的普通文件
  const mcpRoot = mkdtempSync(join(tmpdir(), 'dm-f13-mcpcfg-'));
  const mcpConfigFile = join(mcpRoot, 'mcp-servers', 'servers.json');
  const mcpStore = new McpServersStore(new MinisPaths(mcpRoot));
  mcpStore.upsert({ name: 'a', command: 'echo', args: [], enabled: true });
  const mcpClients: CountingMcpClient[] = [];
  const mcp = new McpManager({ store: mcpStore, chatStore: chat, registry, factories: () => { const c = new CountingMcpClient(); mcpClients.push(c); return c; } });
  await mcp.ensureForRun();

  const psCalls: string[] = [];
  const runPs = async (script: string): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
    psCalls.push(script);
    return { stdout: 'clip', stderr: '', exitCode: 0 };
  };

  // 固定的读目标
  mkdirSync(abs('/var/minis/mcp-servers'), { recursive: true });
  writeFileSync(abs('/var/minis/mcp-servers/servers.json'), `{"note":"${MARKER}"}`, 'utf8');
  const allowAll: PermissionGateway = { async check() { return 'allow'; }, hasBridgeGrant: () => false };
  const seeded = await registry.execute('office_write', JSON.stringify({
    path: '/var/minis/mcp-servers/a.docx', content: JSON.stringify({ blocks: [{ kind: 'para', text: DOC_MARKER }] }), tool_title: '备料',
  }), { sessionId: sid, paths, permissions: allowAll });
  if (!seeded.success) throw new Error(`夹具备料失败: ${seeded.output}`);

  const writeTarget = abs('/var/minis/skills/f13/a.md');
  const editTarget = abs('/var/minis/skills/f13/e.md');
  const docTarget = abs('/var/minis/skills/f13/a.docx');
  const reset = (): void => {
    for (const p of [writeTarget, docTarget]) { try { rmSync(p, { force: true }); } catch { /* 不存在 */ } }
    mkdirSync(dirname(editTarget), { recursive: true });
    writeFileSync(editTarget, 'OLD', 'utf8');
    fetchCalls.length = 0; spawned.length = 0; psCalls.length = 0;
    for (const c of mcpClients) c.callLog.length = 0;
  };

  return {
    root, sid, paths, chat, registry, mcpStore, mcpConfigFile, mcp, mcpClients, search, fetchCalls, spawned, psCalls, abs, db, checkpoints,
    async run(caller, gateway, opts = {}) {
      reset();
      if (caller === 'bridge') {
        // 分发器构造时绑定网关：每次 run 现建一个
        const dispatch = makeBridgeDispatcher({ paths, permissions: gateway, runPs }) as (r: BridgeRequest, ctl?: { signal?: AbortSignal }) => Promise<BridgeEnvelope>;
        const req: BridgeRequest = { tool: 'windows-clipboard', action: 'get', args: {}, sessionId: sid };
        const env = await dispatch(req, opts.bridgeCtl);
        const error = env.error as { code: string; message: string; reason?: string } | undefined;
        return { output: error?.message ?? '', success: env.ok, effects: psCalls.length, code: error?.code, reason: error?.reason };
      }
      let reads = 0;
      const ctx: ToolContext = { sessionId: sid, paths, permissions: gateway, signal: opts.signal, onFileRead: () => { reads++; } };
      if (checkpoints) ctx.checkpoints = checkpoints;
      const r = await registry.execute(caller, JSON.stringify(opts.input ?? INPUTS[caller]), ctx);
      const effects = ((): number => {
        switch (caller) {
          case 'file_read': return reads + (r.output.includes(MARKER) ? 1 : 0);
          case 'file_write': return existsSync(writeTarget) ? 1 : 0;
          case 'file_edit': return readFileSync(editTarget, 'utf8') === 'OLD' ? 0 : 1;
          case 'office_read': return r.output.includes(DOC_MARKER) ? 1 : 0;
          case 'office_write': return existsSync(docTarget) ? 1 : 0;
          case 'file_list': case 'file_glob': case 'file_grep': return r.output.includes('servers.json') ? 1 : 0;
          case 'shell_execute': return spawned.length;
          case 'web_fetch': case 'web_search': return fetchCalls.length;
          case 'mcp__a__echo': return mcpClients.reduce((n, c) => n + c.callLog.length, 0);
        }
      })();
      return { output: r.output, success: r.success, effects };
    },
    dispose() { try { rmSync(root, { recursive: true, force: true }); } catch { /* 收尾尽力 */ } },
  };
}

// ---------- minisd 级 ----------

export function rpcClient(port: number, token: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
  let idc = 0;
  const pending = new Map<number, (v: any) => void>();
  const notifications: { method: string; params: any }[] = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data));
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)!(msg); pending.delete(msg.id); }
    else if (msg.method) notifications.push({ method: msg.method, params: msg.params });
  });
  ws.on('error', () => { /* 关停时连接被断，属预期 */ });
  const ready = new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
  const closed = new Promise<void>(res => { ws.on('close', () => res()); });
  function call(method: string, params?: unknown): Promise<any> {
    const id = ++idc;
    return new Promise((res) => { pending.set(id, res); ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); });
  }
  /** 不等应答就返回：两条消息要紧挨着发出去时用。 */
  function send(method: string, params?: unknown): Promise<any> {
    return call(method, params);
  }
  return { ready, closed, call, send, notifications, close: () => ws.close() };
}
export type Client = ReturnType<typeof rpcClient>;

export const toolScript = (name: string, input: Record<string, unknown>): string => `__tool__ ${name} ${JSON.stringify(input)}`;

/** 会话里落了库的 toolResult（直接读库）。 */
export function toolResults(dataDir: string, sessionId: string): { output: string; success: boolean; [k: string]: unknown }[] {
  const db = new Database(join(dataDir, 'minis.db'), { readonly: true });
  try {
    const rows = db.prepare('SELECT parts_json FROM messages WHERE session_id = ? ORDER BY sort_order').all(sessionId) as { parts_json: string }[];
    return rows.flatMap(r => JSON.parse(r.parts_json)).filter((p: any) => p.type === 'toolResult').map((p: any) => p.value);
  } finally { db.close(); }
}

export interface AuditRow { eventType: string; sessionId: string | null; peerFingerprint: string | null; payload: any }
/** 读审计表（旁路只读连接）。 */
export function readAudit(dataDir: string): AuditRow[] {
  const db = new Database(join(dataDir, 'minis.db'), { readonly: true });
  try {
    const rows = db.prepare('SELECT event_type AS eventType, session_id AS sessionId, peer_fingerprint AS peerFingerprint, payload_json AS payloadJson FROM audit_logs ORDER BY created_at ASC, id ASC')
      .all() as { eventType: string; sessionId: string | null; peerFingerprint: string | null; payloadJson: string }[];
    return rows.map(r => ({ eventType: r.eventType, sessionId: r.sessionId, peerFingerprint: r.peerFingerprint, payload: JSON.parse(r.payloadJson) }));
  } finally { db.close(); }
}

/** 旁路连接建触发器：此后指定 event_type 的审计插入一律失败（SQLITE_FULL / SQLITE_BUSY 的替身）。 */
export function failAuditOn(dataDir: string, eventType: string): void {
  const side = new Database(join(dataDir, 'minis.db'));
  try {
    side.exec(`CREATE TRIGGER inject_audit_fail_${eventType.replace(/[^a-z]/gi, '_')} BEFORE INSERT ON audit_logs WHEN NEW.event_type = '${eventType}'
               BEGIN SELECT RAISE(ABORT, '注入：审计写入失败'); END`);
  } finally { side.close(); }
}

/** 起一个进程内 minisd 并连上一个本机客户端。cleanups 由测试文件的 afterEach 逆序执行。 */
export async function bootMinisd(cleanups: (() => Promise<void> | void)[], opts: StartMinisdOpts = {}) {
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), 'dm-f13-m-'));
  process.env.DESKMINIS_TEST = '1';
  process.env.DESKMINIS_FAKE_PROVIDER = '1';
  const srv = await startMinisd({ host: '127.0.0.1', port: 0, permTimeoutMs: 60000, ...opts, dataDir });
  cleanups.push(() => srv.close());
  const connect = async (): Promise<Client> => {
    const c = rpcClient(srv.port, srv.authToken);
    await c.ready;
    cleanups.push(() => c.close());
    return c;
  };
  const c = await connect();
  return { ...srv, dataDir, c, connect };
}

export const cards = (c: Client, sessionId?: string) =>
  c.notifications.filter(n => n.method === 'permission.request' && (sessionId === undefined || n.params.req.sessionId === sessionId));
export const resolvedOf = (c: Client, requestId: string) =>
  c.notifications.filter(n => n.method === 'permission.resolved' && n.params.requestId === requestId);
export const eventsOf = (c: Client, sessionId: string) =>
  c.notifications.filter(n => n.method === 'chat.event' && n.params.sessionId === sessionId).map(n => n.params.event);
export const turnEnded = (c: Client, sessionId: string, atLeast = 1) =>
  eventsOf(c, sessionId).filter(e => e.kind === 'turnEnd').length >= atLeast;

export async function promptTool(c: Client, sessionId: string, name: string, input: Record<string, unknown>): Promise<void> {
  const r = await c.call('chat.prompt', { sessionId, providerId: '__fake__', text: toolScript(name, input) });
  if (r.error) throw new Error(`chat.prompt 失败: ${r.error.message}`);
}
