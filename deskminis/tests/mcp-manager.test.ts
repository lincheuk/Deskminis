/** D5 MCP 管理器：enabled server 的 run 期连接、mcp__<server>__<tool> 直注册、
 *  权限类目 mcp（askOnce per server）、会话禁用调用层硬执行、崩溃/空闲驱逐重建、
 *  list_changed stale 重列、disposeAll 收口；附 chat-store mcp_disabled 迁移/读写
 *  与 minisd RPC 集成（setMcpDisabled 往返 + mcp.servers.list 带 status）。
 *  W1a-6 起另钉「改动即时生效」：执行器现查全局启停、forget 让下一回合按新配置重连（含连接、列工具、调用途中被 forget 的竞态，成功与失败两条分支都钉；
 *  另有等权限卡期间被 forget 的调用、servers.json 读坏时的调用拒绝）。 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

// ── W1a-6：改动即时生效（设计稿 §2 MCP 末条 / 附录 mcp.md open_questions 8）──────
// 设置页写着「改动即时生效，不用重启」，而 ensureForRun 只连还没连上的服务器、执行器也不看全局启停：
// 停用或改了一台已连上的服务器，它的工具要等 10 分钟空闲驱逐才下表。两步修：
// 执行器每次调用现查 store 的 enabled（工具表不动，不碰前缀稳定）；upsert / remove 之后 forget(name)。

/** 等到条件成立（异步链上的某一步已经走到），缺省最多等 2 秒 */
async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('等待超时');
    await new Promise(r => setTimeout(r, 1));
  }
}

describe('W1a-6 即时生效：执行器现查全局启停 + forget', () => {
  it('全局停用一台已连上的服务器：调用立刻拒「该 MCP server 已停用」，不问权限、不发调用；重新启用即恢复', async () => {
    const store = mkStore();
    seedStdio(store, 'a');
    const mgr = mkManager(store);
    await mgr.ensureForRun();
    const ctx = mkCtx(chat.createSession('s').id);
    promptSpy.answer = 'allow-session';
    store.toggle('a', false);
    const r = await execTool(registry, ctx, 'mcp__a__echo', { tool_title: 'x' });
    expect(r).toEqual({ output: '该 MCP server 已停用', success: false });
    expect(promptSpy.calls).toHaveLength(0);
    expect(clients[0].callLog).toHaveLength(0);
    // 工具表不动（前缀稳定），连接也还在：重新启用后不用重连
    expect(registry.definitions().some(d => d.name === 'mcp__a__echo')).toBe(true);
    store.toggle('a', true);
    const r2 = await execTool(registry, ctx, 'mcp__a__echo', { tool_title: 'x' });
    expect(r2.success).toBe(true);
    expect(clients).toHaveLength(1);
  });

  it('等权限卡期间在设置页停用了它：批准之后也不发调用（闸后重查，同取消的做法）', async () => {
    const store = mkStore();
    seedStdio(store, 'a');
    const mgr = mkManager(store);
    await mgr.ensureForRun();
    const ctx = mkCtx(chat.createSession('s').id);
    promptSpy.answer = 'allow-once';
    promptSpy.onPrompt = () => store.toggle('a', false);
    const r = await execTool(registry, ctx, 'mcp__a__echo', { tool_title: 'x' });
    expect(promptSpy.calls).toHaveLength(1);
    expect(r).toEqual({ output: '该 MCP server 已停用', success: false });
    expect(clients[0].callLog).toHaveLength(0);
  });

  it('配置里已经没有这台（比如手改文件删掉了）：同样在调用前拒绝，不发调用', async () => {
    const store = mkStore();
    seedStdio(store, 'a');
    const mgr = mkManager(store);
    await mgr.ensureForRun();
    store.remove('a');
    const r = await execTool(registry, mkCtx(chat.createSession('s').id), 'mcp__a__echo', { tool_title: 'x' });
    expect(r).toEqual({ output: '该 MCP server 已不在配置中', success: false });
    expect(clients[0].callLog).toHaveLength(0);
  });

  // 读坏时 store 的列表是空的，但这台其实还在文件里——不能说「已不在配置中」，也没法确认它是否仍启用
  it('servers.json 读坏了：已连上的服务器照样拒绝调用，文案说文件读不出来而不是「已不在配置中」，不拼报错原文；修好后原连接即可用', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dm-mgr-'));
    const store = new McpServersStore(new MinisPaths(root));
    const file = join(root, 'mcp-servers', 'servers.json');
    seedStdio(store, 'a');
    const mgr = mkManager(store);
    await mgr.ensureForRun();
    const good = readFileSync(file);
    // 手改文件写坏（设置页叫用户直接改 servers.json），窗口回焦时设置页拉列表会 refresh
    writeFileSync(file, '{"mcpServers":{"a":{"command":"echo","env":{"TOKEN":"sk-SECRET789"}, "x": undefined}}}', 'utf8');
    store.refresh();
    expect(store.loadErrorKind).toBe('parse');
    const ctx = mkCtx(chat.createSession('s').id);
    promptSpy.answer = 'allow-session';
    const r = await execTool(registry, ctx, 'mcp__a__echo', { tool_title: 'x' });
    expect(r).toEqual({ output: 'servers.json 读不出来（格式有误或无法读取），修好前暂不能调用 MCP 工具', success: false });
    expect(r.output).not.toContain('SECRET');
    expect(promptSpy.calls).toHaveLength(0);
    expect(clients[0].callLog).toHaveLength(0);
    // 修好之后不用回设置页：下一次调用自己对比磁盘重读，连接一直没断，不用重连就能用
    // （否则文件早已修好，调用还在说「读不出来」）
    writeFileSync(file, good);
    const r2 = await execTool(registry, ctx, 'mcp__a__echo', { tool_title: 'x' });
    expect(r2).toEqual({ output: 'ok', success: true });
    expect(store.loadErrorKind).toBeUndefined();
    expect(clients).toHaveLength(1);
  });

  // 与 mcp.servers.upsert 处理器同序：先写配置、再 forget。forget 刚把这台重置成 idle（无错误），
  // 批准后的调用不能再把用户刚存好的服务器打成「连接已不可用」的出错态
  it('等权限卡期间改了配置并 forget：批准后不发调用，状态保持 idle、不记错误；下一回合按新配置重连', async () => {
    const store = mkStore();
    seedStdio(store, 'a');
    const mgr = mkManager(store);
    await mgr.ensureForRun();
    const ctx = mkCtx(chat.createSession('s').id);
    promptSpy.answer = 'allow-once';
    promptSpy.onPrompt = () => { store.upsert({ name: 'a', note: 'x' }); mgr.forget('a'); };
    const r = await execTool(registry, ctx, 'mcp__a__echo', { tool_title: 'x' });
    expect(promptSpy.calls).toHaveLength(1);
    expect(r).toEqual({ output: '该 MCP server 配置刚被修改，本次调用未执行', success: false });
    expect(clients[0].callLog).toHaveLength(0);
    expect(mgr.statuses()[0]).toEqual({ name: 'a', status: 'idle', toolCount: 0, truncated: 0 });
    await mgr.ensureForRun();
    expect(clients).toHaveLength(2);
    expect(mgr.statuses()[0].status).toBe('connected');
  });

  // 批准是在旧配置下拿到的：等卡期间别的回合已按新配置连上，也不把这次调用转发到新连接上
  it('等权限卡期间改了配置、且别的回合已按新配置重连：批准后也不把调用发到新连接', async () => {
    const store = mkStore();
    seedStdio(store, 'a');
    const mgr = mkManager(store);
    await mgr.ensureForRun();
    let prompts = 0;
    const gateway = new PermissionGatewayImpl(async () => {
      prompts++;
      store.upsert({ name: 'a', args: ['--v2'] });
      mgr.forget('a');
      await mgr.ensureForRun(); // 等新连接建好、工具重新注册之后才批准
      return 'allow-once';
    });
    const ctx = mkCtx(chat.createSession('s').id, { permissions: gateway });
    const r = await execTool(registry, ctx, 'mcp__a__echo', { tool_title: 'x' });
    expect(prompts).toBe(1);
    expect(r).toEqual({ output: '该 MCP server 配置刚被修改，本次调用未执行', success: false });
    expect(clients).toHaveLength(2);
    expect(clients[0].callLog).toHaveLength(0);
    expect(clients[1].callLog).toHaveLength(0);
    expect(mgr.statuses()[0].status).toBe('connected');
  });

  it('forget：断开旧连接、摘工具、回 idle；下一次 ensureForRun 用新配置重连', async () => {
    const store = mkStore();
    seedStdio(store, 'a');
    const seen: McpServerEntry[] = [];
    const mgr = new McpManager({
      store, chatStore: chat, registry,
      factories: entry => { seen.push(entry); const c = new FakeClient(); c.tools = toolsOf(['echo']); clients.push(c); return c; },
    });
    await mgr.ensureForRun();
    expect(mgr.statuses()[0].status).toBe('connected');
    store.upsert({ name: 'a', args: ['--v2'], env: { K: '2' } });
    mgr.forget('a');
    expect(clients[0].disposeCalls).toBe(1);
    expect(registry.definitions().some(d => d.name === 'mcp__a__echo')).toBe(false);
    expect(mgr.statuses()[0]).toEqual({ name: 'a', status: 'idle', toolCount: 0, truncated: 0 });
    await mgr.ensureForRun();
    expect(clients).toHaveLength(2);
    expect(seen[1]).toMatchObject({ name: 'a', command: 'echo', args: ['--v2'], env: { K: '2' } });
    expect(registry.definitions().some(d => d.name === 'mcp__a__echo')).toBe(true);
    expect(mgr.statuses()[0].status).toBe('connected');
  });

  it('forget 清掉上一次的错误态；对从没连过或不存在的名字是空操作', async () => {
    const store = mkStore();
    seedStdio(store, 'bad');
    const mgr = new McpManager({
      store, chatStore: chat, registry,
      factories: () => { const c = new FakeClient(); c.connectImpl = async () => { throw new Error('MCP server 启动超时（30 秒）'); }; return c; },
    });
    await mgr.ensureForRun();
    expect(mgr.statuses()[0].status).toBe('error');
    mgr.forget('bad');
    expect(mgr.statuses()[0]).toEqual({ name: 'bad', status: 'idle', toolCount: 0, truncated: 0 });
    expect(() => mgr.forget('ghost')).not.toThrow();
  });

  it('连接途中被 forget：按旧配置连上的 client 当场 dispose、不注册工具；下一回合按新配置重连', async () => {
    const store = mkStore();
    seedStdio(store, 'a');
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const mgr = new McpManager({
      store, chatStore: chat, registry,
      factories: () => {
        const c = new FakeClient();
        c.tools = toolsOf(['echo']);
        if (clients.length === 0) c.connectImpl = () => gate; // 只卡第一次连接
        clients.push(c);
        return c;
      },
    });
    const pending = mgr.ensureForRun();
    await until(() => clients.length === 1 && clients[0].connectCalls === 1);
    mgr.forget('a');
    release();
    await pending;
    // 不 dispose 的话这个子进程就成了孤儿：runtime 已经不认它，谁也不会再去关它
    expect(clients[0].disposeCalls).toBe(1);
    expect(registry.definitions().some(d => d.name === 'mcp__a__echo')).toBe(false);
    expect(mgr.statuses()[0].status).toBe('idle');
    await mgr.ensureForRun();
    expect(clients).toHaveLength(2);
    expect(clients[1].disposeCalls).toBe(0);
    expect(mgr.statuses()[0].status).toBe('connected');
  });

  it('列工具途中被 forget：旧 client 的工具表不注册，状态不被旧结果改写', async () => {
    const store = mkStore();
    seedStdio(store, 'a');
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const mgr = new McpManager({
      store, chatStore: chat, registry,
      factories: () => {
        const c = new FakeClient();
        c.tools = toolsOf(['echo']);
        if (clients.length === 0) c.listImpl = async () => { await gate; return c.tools; };
        clients.push(c);
        return c;
      },
    });
    const pending = mgr.ensureForRun();
    await until(() => clients.length === 1 && clients[0].listCalls === 1);
    mgr.forget('a');
    release();
    await pending;
    expect(clients[0].disposeCalls).toBe(1);
    expect(registry.definitions().some(d => d.name === 'mcp__a__echo')).toBe(false);
    expect(mgr.statuses()[0].status).toBe('idle');
  });

  // 上一例的假 listImpl 在 dispose 之后仍正常返回，只走到成功分支。真 client 不是这样：
  // stdio 的 onExit、http 的 onDispose 会让在途请求一律拒绝，生产里 forget 落在列工具途中走的是 catch 分支。
  it('列工具途中被 forget、旧请求随 dispose 拒绝时新连接已建好：迟到的失败不把新连接打成出错，也不丢下新进程', async () => {
    const store = mkStore();
    seedStdio(store, 'a');
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const mgr = new McpManager({
      store, chatStore: chat, registry,
      factories: () => {
        const c = new FakeClient();
        c.tools = toolsOf(['echo']);
        // 只卡第一次：等闸打开后以 stdio onExit 的同款文案拒绝
        if (clients.length === 0) c.listImpl = async () => { await gate; throw new Error('MCP server 进程已退出（code 未知）'); };
        clients.push(c);
        return c;
      },
    });
    const pending = mgr.ensureForRun();
    await until(() => clients.length === 1 && clients[0].listCalls === 1);
    mgr.forget('a');
    await mgr.ensureForRun(); // 下一回合按新配置连上 clients[1]
    expect(mgr.statuses()[0].status).toBe('connected');
    release();
    await pending;
    expect(mgr.statuses()[0].status).toBe('connected');
    expect(registry.definitions().some(d => d.name === 'mcp__a__echo')).toBe(true);
    expect(clients[0].disposeCalls).toBe(1);
    expect(clients[1].disposeCalls).toBe(0);
    // runtime 仍攥着 clients[1]：再来一回合不重连，退出收口时它会被关掉（否则就是没人管的孤儿进程）
    await mgr.ensureForRun();
    expect(clients).toHaveLength(2);
    mgr.disposeAll();
    expect(clients[1].disposeCalls).toBe(1);
  });

  it('连接途中被 forget、按旧配置的连接最终失败：状态仍是 idle，不把旧配置的错误记到新配置头上', async () => {
    const store = mkStore();
    seedStdio(store, 'a');
    let fail!: () => void;
    const gate = new Promise<void>((_res, rej) => { fail = () => rej(new Error('MCP server 启动超时（30 秒）')); });
    const mgr = new McpManager({
      store, chatStore: chat, registry,
      factories: () => {
        const c = new FakeClient();
        c.tools = toolsOf(['echo']);
        if (clients.length === 0) c.connectImpl = () => gate; // 只卡第一次连接
        clients.push(c);
        return c;
      },
    });
    const pending = mgr.ensureForRun();
    await until(() => clients.length === 1 && clients[0].connectCalls === 1);
    mgr.forget('a');
    fail();
    await pending;
    // 设置页看到的是改后那份配置的状态：还没连过，就是 idle，不是旧配置的「启动超时」
    expect(mgr.statuses()[0]).toEqual({ name: 'a', status: 'idle', toolCount: 0, truncated: 0 });
    await mgr.ensureForRun();
    expect(clients).toHaveLength(2);
    expect(mgr.statuses()[0].status).toBe('connected');
  });

  it('调用途中被 forget 且已重连：旧连接迟到的「连接已关闭」不会把新连接标成出错', async () => {
    const store = mkStore();
    seedStdio(store, 'a');
    const mgr = mkManager(store);
    await mgr.ensureForRun();
    const ctx = mkCtx(chat.createSession('s').id);
    promptSpy.answer = 'allow-session';
    const old = clients[0];
    let fail!: () => void;
    old.callImpl = () => new Promise((_res, rej) => { fail = () => rej(new Error('MCP server 连接已关闭')); });
    const running = execTool(registry, ctx, 'mcp__a__echo', { tool_title: 'x' });
    await until(() => old.callLog.length === 1);
    mgr.forget('a');
    old.closed = true;
    await mgr.ensureForRun();
    expect(clients).toHaveLength(2);
    fail();
    const r = await running;
    expect(r.success).toBe(false);
    expect(clients[1].disposeCalls).toBe(0);
    expect(mgr.statuses()[0].status).toBe('connected');
    expect(registry.definitions().some(d => d.name === 'mcp__a__echo')).toBe(true);
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
  // W1a-6 起也收广播：即时生效例要等回合结束（chat.event turnEnd）再往下走
  const notifications: { method: string; params: any }[] = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data));
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)!(msg); pending.delete(msg.id); }
    else if (msg.method) notifications.push({ method: msg.method, params: msg.params });
  });
  const ready = new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
  function call(method: string, params?: unknown): Promise<any> {
    const id = ++idc;
    return new Promise((res) => { pending.set(id, res); ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); });
  }
  return { ready, call, notifications, close: () => ws.close() };
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

describe('RPC 集成（W1a-6）：mcp.servers.upsert / remove 之后下一回合按新配置重连', () => {
  it('改备注、改名、删除都让旧连接下线；手改文件加回旧名时它是 idle，不是还连着的旧进程', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dm-mcp-live-'));
    const file = join(dataDir, 'mcp-servers', 'servers.json');
    mkdirSync(join(dataDir, 'mcp-servers'), { recursive: true });
    // 真起 fixture 子进程（electron 以 ELECTRON_RUN_AS_NODE=1 跑成 node），照 mcp-test-rpc.test.ts
    const FX = { command: process.execPath, args: [join(__dirname, 'mcp-stdio-server.mjs')], env: { ELECTRON_RUN_AS_NODE: '1' } };
    writeFileSync(file, JSON.stringify({ mcpServers: { fx: FX } }), 'utf8');
    process.env.DESKMINIS_TEST = '1';
    process.env.DESKMINIS_FAKE_PROVIDER = '1';
    const srv = await startMinisd({ dataDir, host: '127.0.0.1', port: 0 });
    stopSrv = srv.close;
    const c = rpcClient(srv.port, srv.authToken); await c.ready;
    const statusOf = async (name: string) =>
      (await c.call('mcp.servers.list', {})).result.statuses.find((x: any) => x.name === name)?.status;
    /** 开一个新会话发一句话：chat.prompt 返回前已经 await 完 ensureForRun（enabled 的服务器都连上了），
     *  再等回合结束，免得关服务时循环还在跑 */
    const runOnce = async () => {
      const s = (await c.call('chat.sessions.create', {})).result;
      const r = await c.call('chat.prompt', { sessionId: s.id, providerId: '__fake__', text: 'hi' });
      expect(r.error).toBeUndefined();
      await until(() => c.notifications.some(n => n.method === 'chat.event' && n.params?.sessionId === s.id
        && (n.params.event?.kind === 'turnEnd' || n.params.event?.kind === 'error')), 10_000);
    };
    /** 用户在应用开着时手改 servers.json 加回一条（W1a-5：list 会先对比磁盘重读） */
    const handAdd = (name: string) => {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      raw.mcpServers[name] = FX;
      writeFileSync(file, JSON.stringify(raw), 'utf8');
    };

    await runOnce();
    expect(await statusOf('fx')).toBe('connected');

    // ① 只改备注（补丁语义：command / args / env 都还在），旧连接下线，下一回合重连
    expect((await c.call('mcp.servers.upsert', { name: 'fx', note: '改了' })).result).toEqual({ ok: true });
    expect(await statusOf('fx')).toBe('idle');
    const listed = (await c.call('mcp.servers.list', {})).result.servers[0];
    expect(listed).toMatchObject({ name: 'fx', command: FX.command, args: FX.args, env: FX.env, note: '改了' });
    await runOnce();
    expect(await statusOf('fx')).toBe('connected');

    // ② 改名：新名 idle；旧名那条连接也下线了——手改文件加回旧名，它是 idle 而不是还连着
    expect((await c.call('mcp.servers.upsert', { name: 'fx2', renameFrom: 'fx' })).result).toEqual({ ok: true });
    expect((await c.call('mcp.servers.list', {})).result.servers.map((x: any) => x.name)).toEqual(['fx2']);
    expect(await statusOf('fx2')).toBe('idle');
    handAdd('fx');
    expect(await statusOf('fx')).toBe('idle');

    // ③ 删除：同上，删掉再手改加回来，旧连接不会「复活」
    await runOnce();
    expect(await statusOf('fx')).toBe('connected');
    expect((await c.call('mcp.servers.remove', { name: 'fx' })).result).toEqual({ ok: true });
    handAdd('fx');
    expect(await statusOf('fx')).toBe('idle');
    c.close();
  }, 20_000);
});
