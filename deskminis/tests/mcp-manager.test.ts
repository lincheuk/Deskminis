/** D5 MCP 管理器：enabled server 的 run 期连接、mcp__<server>__<tool> 直注册、
 *  权限类目 mcp（askOnce per server）、会话禁用调用层硬执行、崩溃/空闲驱逐重建、
 *  list_changed stale 重列、disposeAll 收口；附 chat-store mcp_disabled 迁移/读写
 *  与 minisd RPC 集成（setMcpDisabled 往返 + mcp.servers.list 带 status）。 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import { McpManager } from '../src/minisd/mcp/manager';
import type { McpClientLike } from '../src/minisd/mcp/manager';
import { McpServersStore, type McpServerEntry } from '../src/minisd/mcp/config';
import type { McpNotification, McpToolInfo } from '../src/minisd/mcp/stdio';
import { MinisPaths } from '../src/minisd/paths';
import { ToolRegistry } from '../src/minisd/tools/registry';
import { PermissionGatewayImpl } from '../src/minisd/tools/permissions';
import type { PermissionRequest, ToolContext } from '../src/minisd/tools/types';
import { ChatStore } from '../src/minisd/store/chat-store';
import { openDb } from '../src/minisd/store/db';
import { startMinisd } from '../src/minisd/index';
import type Database from 'better-sqlite3';

// ── 测试基座 ─────────────────────────────────────────────────────────────

/** 与真 client（McpStdioClient/McpHttpClient）同形的假客户端：行为全部可编程注入 */
class FakeClient implements McpClientLike {
  onNotification: ((n: McpNotification) => void) | undefined;
  closed = false;
  tools: McpToolInfo[] = [];
  connectCalls = 0;
  listCalls = 0;
  disposeCalls = 0;
  callLog: Array<{ name: string; args: Record<string, unknown> | undefined }> = [];
  connectImpl: () => Promise<void> = async () => {};
  listImpl: () => Promise<McpToolInfo[]> = async () => this.tools;
  callImpl: (name: string, args: Record<string, unknown> | undefined) => Promise<unknown> =
    async () => ({ content: [{ type: 'text', text: 'ok' }] });
  async connect(): Promise<void> { this.connectCalls++; await this.connectImpl(); }
  async listTools(): Promise<McpToolInfo[]> { this.listCalls++; return this.listImpl(); }
  async callTool(name: string, args?: Record<string, unknown>): Promise<unknown> {
    this.callLog.push({ name, args });
    return this.callImpl(name, args);
  }
  dispose(): void { this.disposeCalls++; }
}

function mkStore(): McpServersStore { return new McpServersStore(new MinisPaths(mkdtempSync(join(tmpdir(), 'dm-mgr-')))); }

let db: Database.Database;
let chat: ChatStore;
let registry: ToolRegistry;
let clients: FakeClient[];
let promptSpy: { calls: PermissionRequest[]; answer: 'allow-once' | 'allow-session' | 'deny'; onPrompt?: () => void };

beforeEach(() => {
  db = openDb(':memory:');
  chat = new ChatStore(db);
  registry = new ToolRegistry();
  clients = [];
  promptSpy = { calls: [], answer: 'allow-session' };
});

function mkManager(store: McpServersStore): McpManager {
  return new McpManager({
    store, chatStore: chat, registry,
    factories: (_entry: McpServerEntry) => {
      const c = new FakeClient();
      c.tools = toolsOf(['echo']);
      clients.push(c);
      return c;
    },
  });
}

function seedStdio(store: McpServersStore, name: string, enabled = true): void {
  store.upsert({ name, command: 'echo', args: [], enabled });
}

function toolsOf(names: string[]): McpToolInfo[] {
  return names.map(n => ({ name: n, description: `工具 ${n}`, inputSchema: { type: 'object', properties: {} } }));
}

const ROOT = mkdtempSync(join(tmpdir(), 'dm-mgr-paths-'));
function mkCtx(sid: string, over: Partial<ToolContext> = {}): ToolContext {
  const gateway = new PermissionGatewayImpl(async req => { promptSpy.calls.push(req); promptSpy.onPrompt?.(); return promptSpy.answer; });
  return { sessionId: sid, paths: new MinisPaths(ROOT), permissions: gateway, ...over };
}

async function execTool(reg: ToolRegistry, ctx: ToolContext, name: string, input: Record<string, unknown>) {
  return reg.execute(name, JSON.stringify(input), ctx);
}

// ── ensureForRun：并行连接与注册 ─────────────────────────────────────────

describe('McpManager ensureForRun（1-2）', () => {
  it('两台 enabled 并行连接，mcp__ 工具进 registry；disabled 台不连', async () => {
    const store = mkStore();
    seedStdio(store, 'a'); seedStdio(store, 'b'); seedStdio(store, 'off', false);
    const mgr = mkManager(store);
    await mgr.ensureForRun();
    const names = registry.definitions().map(d => d.name);
    expect(names).toContain('mcp__a__echo');
    expect(clients).toHaveLength(2); // disabled 台从未建 client
    const st = mgr.statuses();
    expect(st.find(s => s.name === 'a')).toMatchObject({ status: 'connected', toolCount: 1, truncated: 0 });
    expect(st.find(s => s.name === 'off')).toMatchObject({ status: 'idle', toolCount: 0 });
  });

  it('单台失败：status=error + 中文 lastError；另一台照常；不抛', async () => {
    const store = mkStore();
    seedStdio(store, 'bad'); seedStdio(store, 'good');
    const mgr = new McpManager({
      store, chatStore: chat, registry,
      factories: entry => {
        const c = new FakeClient();
        if (entry.name === 'bad') c.connectImpl = async () => { throw new Error('MCP server 启动超时（30 秒）'); };
        else c.tools = toolsOf(['echo']);
        clients.push(c);
        return c;
      },
    });
    await expect(mgr.ensureForRun()).resolves.toBeUndefined();
    const st = mgr.statuses();
    expect(st.find(s => s.name === 'bad')).toMatchObject({ status: 'error' });
    expect(st.find(s => s.name === 'bad')!.lastError).toContain('启动超时');
    expect(st.find(s => s.name === 'good')!.status).toBe('connected');
    expect(registry.definitions().map(d => d.name)).toContain('mcp__good__echo');
    expect(registry.definitions().some(d => d.name.startsWith('mcp__bad__'))).toBe(false);
  });
});

// ── 命名：非法字符 / 超长截断哈希 / 撞名 / 上限 ─────────────────────────

describe('McpManager 命名与上限（3-4）', () => {
  it('非法字符替换为 _；超长名截断 + 12 位哈希且两次一致；撞名后者跳过', async () => {
    const store = mkStore();
    store.upsert({ name: 'a.b', command: 'echo' });
    const mgr = mkManager(store);
    await mgr.ensureForRun();
    // 直接操纵 client 工具表 + stale 重列来观察命名（走同一条注册路径）
    const c = clients[0];
    const long1 = 't'.repeat(80);
    const long2 = 'u'.repeat(80);
    c.tools = [...toolsOf(['x y', long1, long2, long1])];
    c.onNotification?.({ method: 'tools/list_changed' });
    await mgr.ensureForRun();
    const names = registry.definitions().map(d => d.name);
    expect(names).toContain('mcp__a_b__x_y');
    const cut1 = names.find(n => n.startsWith('mcp__a_b__t'));
    const cut2 = names.find(n => n.startsWith('mcp__a_b__u'));
    expect(cut1).toBeDefined();
    expect(cut2).toBeDefined();
    // 形态：截到 52 + '_' + 12 位 hex；不同长名哈希不同；同一长名重复出现只注册一次（撞名跳过）
    const tailOf = (full: string) => full.slice(53);
    expect(cut1!.length).toBe(65);
    expect(tailOf(cut1!)).toMatch(/^[0-9a-f]{12}$/);
    expect(tailOf(cut1!)).not.toBe(tailOf(cut2!));
    // 期望哈希 = sha256(原始全名) 前 12
    const expectHash = (n: string) => createHash('sha256').update(n).digest('hex').slice(0, 12);
    expect(tailOf(cut1!)).toBe(expectHash(`mcp__a_b__${long1}`));
    expect(tailOf(cut2!)).toBe(expectHash(`mcp__a_b__${long2}`));
    // long1 出现两次 → 第二个跳过并计入 truncated（注册 3 个：x_y + 两个长名截断哈希）
    const st = mgr.statuses().find(s => s.name === 'a.b')!;
    expect(st.toolCount).toBe(3);
    expect(st.truncated).toBe(1);
    expect(names.filter(n => n === cut1)).toHaveLength(1);
  });

  it('单台 41 个 → 注册 40 + truncated=1；全局 120 封顶', async () => {
    const store = mkStore();
    seedStdio(store, 'solo');
    const mgr = mkManager(store);
    await mgr.ensureForRun();
    clients[0].tools = toolsOf(Array.from({ length: 41 }, (_, i) => `t${i}`));
    clients[0].onNotification?.({ method: 'tools/list_changed' });
    await mgr.ensureForRun();
    const st = mgr.statuses().find(s => s.name === 'solo')!;
    expect(st.toolCount).toBe(40);
    expect(st.truncated).toBe(1);
    expect(registry.definitions().filter(d => d.name.startsWith('mcp__solo__'))).toHaveLength(40);
    // 按返回序截断：t0..t39 注册，t40 被截
    expect(registry.definitions().some(d => d.name === 'mcp__solo__t39')).toBe(true);
    expect(registry.definitions().some(d => d.name === 'mcp__solo__t40')).toBe(false);

    // 全局上限：另起 4 台 × 40 工具
    const store2 = mkStore();
    for (const n of ['x1', 'x2', 'x3', 'x4']) seedStdio(store2, n);
    const reg2 = new ToolRegistry();
    const mgr2 = new McpManager({
      store: store2, chatStore: chat, registry: reg2,
      factories: () => {
        const c = new FakeClient();
        c.tools = toolsOf(Array.from({ length: 40 }, (_, i) => `t${i}`));
        return c;
      },
    });
    await mgr2.ensureForRun();
    expect(reg2.definitions().filter(d => d.name.startsWith('mcp__')).length).toBe(120);
    const totalTruncated = mgr2.statuses().reduce((s, x) => s + x.truncated, 0);
    expect(totalTruncated).toBe(40);
  });
});

// ── definition 透传与执行器消化 ─────────────────────────────────────────

describe('McpManager definition 与执行器（5-6）', () => {
  it('definition：description/rawInputSchema 透传，参数表只含 tool_title 且 required=["tool_title"]', async () => {
    const store = mkStore();
    seedStdio(store, 'a');
    const mgr = mkManager(store);
    const schema = { type: 'object', properties: { q: { type: 'string', description: '查询' }, opts: { type: 'object', properties: { deep: { type: 'boolean' } } } }, required: ['q'] };
    clients.length = 0;
    const mgr2 = new McpManager({
      store, chatStore: chat, registry,
      factories: () => {
        const c = new FakeClient();
        c.tools = [{ name: 'search', description: '搜索', inputSchema: schema }];
        clients.push(c);
        return c;
      },
    });
    await mgr2.ensureForRun();
    const def = registry.definitions().find(d => d.name === 'mcp__a__search')!;
    expect(def.description).toBe('搜索');
    expect(def.rawInputSchema).toEqual(schema);
    expect(def.parameters).toHaveProperty('tool_title');
    expect(Object.keys(def.parameters)).toEqual(['tool_title']);
    expect(def.required).toEqual(['tool_title']);
  });

  it('执行器：text 换行拼接；非文本占位；isError 前缀 + success:false', async () => {
    const store = mkStore();
    seedStdio(store, 'a');
    const mgr = mkManager(store);
    await mgr.ensureForRun();
    const c = clients[0];
    const sid = chat.createSession('s').id;
    const ctx = mkCtx(sid);
    promptSpy.answer = 'allow-session';

    c.callImpl = async () => ({ content: [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }] });
    const r1 = await execTool(registry, ctx, 'mcp__a__echo', { tool_title: '调用' });
    expect(r1).toEqual({ output: '第一段\n第二段', success: true });

    c.callImpl = async () => ({ content: [{ type: 'text', text: 't' }, { type: 'image', data: 'x' }] });
    const r2 = await execTool(registry, ctx, 'mcp__a__echo', { tool_title: '调用' });
    expect(r2.output).toBe('t\n[非文本内容：image，暂不支持]');

    c.callImpl = async () => ({ content: [{ type: 'text', text: '炸了' }], isError: true });
    const r3 = await execTool(registry, ctx, 'mcp__a__echo', { tool_title: '调用' });
    expect(r3.success).toBe(false);
    expect(r3.output).toBe('MCP 工具报错: 炸了');
    // 入参剔除 tool_title 后透传原始工具名
    c.callImpl = async () => ({ content: [{ type: 'text', text: 'ok' }] });
    await execTool(registry, ctx, 'mcp__a__echo', { tool_title: '标题', real: 1 });
    expect(c.callLog.at(-1)).toEqual({ name: 'echo', args: { real: 1 } });
  });

  it('总输出超 64K 码点截断加注（Array.from 防切 emoji）', async () => {
    const store = mkStore();
    seedStdio(store, 'a');
    const mgr = mkManager(store);
    await mgr.ensureForRun();
    const sid = chat.createSession('s').id;
    const ctx = mkCtx(sid);
    promptSpy.answer = 'allow-session';
    // 全 emoji：任何按 UTF-16 unit 的硬切都会产生半个代理对
    clients[0].callImpl = async () => ({ content: [{ type: 'text', text: '😀'.repeat(70000) }] });
    const r = await execTool(registry, ctx, 'mcp__a__echo', { tool_title: '调用' });
    const cps = Array.from(r.output);
    expect(cps.length).toBe(65536); // 截断后总量（含截断注记）恰为 64K 码点
    expect(r.output).toContain('已截断');
    // 无半个代理对：每个码点都是完整字符（😀 是 2 个 UTF-16 unit、1 个码点）
    const units = r.output.split('\n')[0];
    expect(units.length % 2).toBe(0);
  });
});

// ── 权限与取消（7）──────────────────────────────────────────────────────

describe('McpManager 权限（7）', () => {
  it('kind=mcp detail=server 名；askOnce 同台第二次不问；deny 拒绝且 callTool 未被调；闸后取消重查', async () => {
    const store = mkStore();
    seedStdio(store, 'alpha');
    const mgr = mkManager(store);
    await mgr.ensureForRun();
    const sid = chat.createSession('s').id;
    const ctx = mkCtx(sid);
    promptSpy.answer = 'allow-session';
    const r0 = await execTool(registry, ctx, 'mcp__alpha__echo', { tool_title: 'x' });
    expect(promptSpy.calls[0]).toMatchObject({ kind: 'mcp', detail: 'alpha', sessionId: sid, toolTitle: 'x' });
    expect(r0.success).toBe(true);
    // 第二次（allow-session 语义下同台不再问）——此处 askOnce 档位本应每次都问，
    // 「同台第二次不问」由 allow-session 授权记忆实现（与 shell 同款），此处断言不再弹
    await execTool(registry, ctx, 'mcp__alpha__echo', { tool_title: 'y' });
    expect(promptSpy.calls).toHaveLength(1);

    // deny → 拒绝文案且未发调用
    const denyCtx = mkCtx(chat.createSession('s2').id);
    promptSpy.answer = 'deny';
    const before = clients[0].callLog.length;
    const rd = await execTool(registry, denyCtx, 'mcp__alpha__echo', { tool_title: 'z' });
    expect(rd.success).toBe(false);
    expect(rd.output).toBe('MCP 调用被用户拒绝（可在设置-权限中调整）');
    expect(clients[0].callLog.length).toBe(before);

    // 闸后取消重查：prompt 期间用户点了停止
    const ac = new AbortController();
    const cancelCtx = mkCtx(chat.createSession('s3').id, { signal: ac.signal });
    promptSpy.answer = 'allow-once';
    promptSpy.onPrompt = () => ac.abort();
    const rc = await execTool(registry, cancelCtx, 'mcp__alpha__echo', { tool_title: 'w' });
    expect(rc).toEqual({ output: '[已取消]', success: false });
    expect(clients[0].callLog.length).toBe(before); // 未发调用

    // 进入即取消：不发起权限询问
    const ac2 = new AbortController(); ac2.abort();
    const preCtx = mkCtx(chat.createSession('s4').id, { signal: ac2.signal });
    const callsBefore = promptSpy.calls.length;
    const rp = await execTool(registry, preCtx, 'mcp__alpha__echo', { tool_title: 'v' });
    expect(rp).toEqual({ output: '[已取消]', success: false });
    expect(promptSpy.calls.length).toBe(callsBefore);
  });
});

// ── 会话禁用（8）────────────────────────────────────────────────────────

describe('McpManager 会话禁用（8）', () => {
  it('store 设禁用 → 调用层拒（工具仍在表内）；excludedToolNames 合并', async () => {
    const store = mkStore();
    seedStdio(store, 'a'); seedStdio(store, 'b');
    const mgr = mkManager(store);
    await mgr.ensureForRun();
    const sid = chat.createSession('s').id;
    chat.setMcpDisabled(sid, ['a']);
    const ctx = mkCtx(sid);
    promptSpy.answer = 'allow-session';
    const r = await execTool(registry, ctx, 'mcp__a__echo', { tool_title: 'x' });
    expect(r.success).toBe(false);
    expect(r.output).toBe('该 MCP server 已在本会话禁用');
    expect(clients[0].callLog).toHaveLength(0); // 禁用拦截在权限闸之前/之内，未发调用
    // 未禁用的台照常
    const rb = await execTool(registry, ctx, 'mcp__b__echo', { tool_title: 'x' });
    expect(rb.success).toBe(true);
    // 排除集：禁用台的全部工具名
    const excluded = mgr.excludedToolNames(sid);
    expect(excluded.has('mcp__a__echo')).toBe(true);
    expect(excluded.has('mcp__b__echo')).toBe(false);
  });
});

// ── 崩溃 / list_changed / 空闲驱逐 / disposeAll（9-12）─────────────────

describe('McpManager 生命周期（9-12）', () => {
  it('崩溃：调用抛「进程已退出」→ error + unregister；下次 ensureForRun 重连重注册', async () => {
    const store = mkStore();
    seedStdio(store, 'a');
    const mgr = mkManager(store);
    await mgr.ensureForRun();
    const sid = chat.createSession('s').id;
    const ctx = mkCtx(sid);
    promptSpy.answer = 'allow-session';
    await execTool(registry, ctx, 'mcp__a__echo', { tool_title: 'x' }); // 先建立会话授权
    const dead = clients[0];
    dead.callImpl = async () => { throw new Error('MCP server 进程已退出（code 1）'); };
    dead.closed = true;
    const r = await execTool(registry, ctx, 'mcp__a__echo', { tool_title: 'x' });
    expect(r.success).toBe(false);
    expect(r.output).toContain('进程已退出');
    expect(registry.definitions().some(d => d.name === 'mcp__a__echo')).toBe(false);
    expect(mgr.statuses().find(s => s.name === 'a')!.status).toBe('error');
    // 重连重建：工厂再被调用，新 client 工具重新注册
    const prevClients = clients.length;
    await mgr.ensureForRun();
    expect(clients.length).toBe(prevClients + 1);
    expect(registry.definitions().some(d => d.name === 'mcp__a__echo')).toBe(true);
    expect(mgr.statuses().find(s => s.name === 'a')!.status).toBe('connected');
  });

  it('list_changed：stale → 重 list 后注册表刷新（旧消失新出现）', async () => {
    const store = mkStore();
    seedStdio(store, 'a');
    const mgr = mkManager(store);
    await mgr.ensureForRun();
    const c = clients[0];
    const listCallsBefore = c.listCalls;
    c.tools = toolsOf(['new1', 'new2']);
    c.onNotification?.({ method: 'tools/list_changed' });
    await mgr.ensureForRun(); // stale 台即使已连接也要重 list
    expect(c.listCalls).toBe(listCallsBefore + 1);
    const names = registry.definitions().map(d => d.name).filter(n => n.startsWith('mcp__a__'));
    expect(names.sort()).toEqual(['mcp__a__new1', 'mcp__a__new2']);
  });

  it('空闲驱逐：过期 → dispose + unregister + idle；未过期不动', async () => {
    const store = mkStore();
    seedStdio(store, 'a');
    const mgr = mkManager(store);
    await mgr.ensureForRun();
    const sid = chat.createSession('s').id;
    const ctx = mkCtx(sid);
    promptSpy.answer = 'allow-session';
    await execTool(registry, ctx, 'mcp__a__echo', { tool_title: 'x' });
    const now = Date.now();
    // 10 分钟阈值：+9 分钟不驱逐
    mgr.checkIdleEvictions(now + 9 * 60_000);
    expect(clients[0].disposeCalls).toBe(0);
    expect(registry.definitions().some(d => d.name === 'mcp__a__echo')).toBe(true);
    // +11 分钟驱逐
    mgr.checkIdleEvictions(now + 11 * 60_000);
    expect(clients[0].disposeCalls).toBe(1);
    expect(registry.definitions().some(d => d.name === 'mcp__a__echo')).toBe(false);
    expect(mgr.statuses().find(s => s.name === 'a')!.status).toBe('idle');
    // 驱逐后下次 ensureForRun 重连
    await mgr.ensureForRun();
    expect(mgr.statuses().find(s => s.name === 'a')!.status).toBe('connected');
  });

  it('disposeAll 幂等：全部 dispose，二次调用不抛', async () => {
    const store = mkStore();
    seedStdio(store, 'a'); seedStdio(store, 'b');
    const mgr = mkManager(store);
    await mgr.ensureForRun();
    mgr.disposeAll();
    expect(clients.every(c => c.disposeCalls === 1)).toBe(true);
    expect(() => mgr.disposeAll()).not.toThrow();
    expect(clients.every(c => c.disposeCalls === 1)).toBe(true);
  });
});

// ── chat-store：mcp_disabled 列迁移与读写 ────────────────────────────────

describe('chat-store mcp_disabled（迁移 + 两方法）', () => {
  it('旧库（无列）打开 ChatStore 不炸，迁移补列', () => {
    const raw = openDb(':memory:');
    const cols = (raw.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).not.toContain('mcp_disabled_json'); // db.ts 基线 schema 无此列
    expect(() => new ChatStore(raw)).not.toThrow();
    const cols2 = (raw.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map(c => c.name);
    expect(cols2).toContain('mcp_disabled_json');
    raw.close();
  });

  it('get 空/损坏回 []；set→get 往返；重复构造幂等', () => {
    const s = chat.createSession('s').id;
    expect(chat.getMcpDisabled(s)).toEqual([]);
    chat.setMcpDisabled(s, ['a', 'b']);
    expect(chat.getMcpDisabled(s)).toEqual(['a', 'b']);
    chat.setMcpDisabled(s, []);
    expect(chat.getMcpDisabled(s)).toEqual([]);
    // 损坏 JSON 容错
    db.prepare('UPDATE sessions SET mcp_disabled_json=? WHERE id=?').run('not-json', s);
    expect(chat.getMcpDisabled(s)).toEqual([]);
    // 非字符串数组成员过滤
    db.prepare('UPDATE sessions SET mcp_disabled_json=? WHERE id=?').run(JSON.stringify(['a', 1, null]), s);
    expect(chat.getMcpDisabled(s)).toEqual(['a']);
    // 二次构造（列已存在）不炸
    expect(() => new ChatStore(db)).not.toThrow();
  });
});

// ── RPC 集成（boot minisd）──────────────────────────────────────────────

let stopSrv: (() => Promise<void>) | undefined;
afterEach(async () => { await stopSrv?.(); stopSrv = undefined; });

function rpcClient(port: number, token: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
  let idc = 0;
  const pending = new Map<number, (v: any) => void>();
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data));
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)!(msg); pending.delete(msg.id); }
  });
  const ready = new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
  function call(method: string, params?: unknown): Promise<any> {
    const id = ++idc;
    return new Promise((res) => { pending.set(id, res); ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); });
  }
  return { ready, call, close: () => ws.close() };
}

describe('RPC 集成：setMcpDisabled 往返 + mcp.servers.list 带 status', () => {
  it('boot minisd：会话禁用写读往返；servers.list 合并 statuses（未连接 idle）', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dm-mcp-rpc-'));
    process.env.DESKMINIS_TEST = '1';
    process.env.DESKMINIS_FAKE_PROVIDER = '1';
    const srv = await startMinisd({ dataDir, host: '127.0.0.1', port: 0 });
    stopSrv = srv.close;
    const c = rpcClient(srv.port, srv.authToken); await c.ready;
    const s = (await c.call('chat.sessions.create', {})).result;
    await c.call('mcp.servers.upsert', { name: 'demo', command: 'echo' });
    await c.call('chat.sessions.setMcpDisabled', { sessionId: s.id, servers: ['demo'] });
    const sessions = (await c.call('chat.sessions.list', {})).result;
    expect(sessions.find((x: any) => x.id === s.id)?.mcpDisabled).toEqual(['demo']);
    const list = (await c.call('mcp.servers.list', {})).result;
    expect(list.servers.map((x: any) => x.name)).toEqual(['demo']);
    expect(list.statuses).toEqual([{ name: 'demo', status: 'idle', toolCount: 0, truncated: 0 }]);
    // 清空往返
    await c.call('chat.sessions.setMcpDisabled', { sessionId: s.id, servers: [] });
    const sessions2 = (await c.call('chat.sessions.list', {})).result;
    expect(sessions2.find((x: any) => x.id === s.id)?.mcpDisabled).toEqual([]);
    c.close();
  });
});
