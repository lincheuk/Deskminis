/**
 * W1b-5d（设计稿 §4.1 · 接 W1b-5、W1b-1）：关停等进程树回收做完再退。
 *
 * 旧的关停第 6 步是三句同步的 shutdownStep（销毁终端 / shell / 断开 MCP），起了 taskkill 就往下关桥、关 rpc、关库，
 * standalone 随即 exit(0)。taskkill 是 minisd 的直接子进程：libuv 把非 detached 的子进程放进「作业关闭即杀」的作业对象，
 * minisd 一退，还没跑完的 taskkill 跟着被结束；而作业带 SILENT_BREAKAWAY_OK，只收直接子进程——npx 拉起的 node、
 * 终端里的 dev server、shell 里的 ping -t 这些孙进程不在作业里，没人收就成了孤儿（W3-smoke 三审实测冒烟打断后孙进程留下）。
 *
 * 新行为（本文件钉住）：
 *  - 终端、shell、MCP 的 disposeAll 返回「全部回收落定」的 Promise；一个会话的回收同步抛错不拖累其余会话；
 *    单个会话的 dispose 也返回 Promise（调用方可以不等）。
 *  - 关停第 6 步 shutdownReap：三者各自兜住地发起（一个抛错只记一笔、其余照做），再一起等落定，最多等 REAP_WAIT_MS，
 *    到点照样往下关桥、rpc、库。
 *  - 进程内起 minisd（注入假 spawn，platform 设 'win32' 走 taskkill 分支）：taskkill 退出之前库不关、锁不放，
 *    close 不落定；全部退出后 close 才完成；taskkill 永远不退时等满上限照样关库放锁。
 *
 * 为什么注入假 spawn：taskkill、PowerShell 都是 Windows 的东西，Linux 上 killTree 走 child.kill、立即落定，测不到「等」。
 * 假子进程兼当 PowerShell 驱动与 MCP server：stdin 收到 shell 的命令行就回完成哨兵、收到 JSON-RPC 请求就回空结果。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { TerminalManager, TerminalSession } from '../src/minisd/terminal';
import { PersistentShell, ShellManager } from '../src/minisd/tools/shell';
import { McpStdioClient } from '../src/minisd/mcp/stdio';
import { McpHttpClient } from '../src/minisd/mcp/http';
import { McpManager, type McpClientLike } from '../src/minisd/mcp/manager';
import { McpServersStore } from '../src/minisd/mcp/config';
import type { McpNotification, McpToolInfo } from '../src/minisd/mcp/stdio';
import { ToolRegistry } from '../src/minisd/tools/registry';
import { ChatStore } from '../src/minisd/store/chat-store';
import { openDb } from '../src/minisd/store/db';
import { MinisPaths, DATA_ROOT_LOCK_NAME } from '../src/minisd/paths';
import { startMinisd, shutdownReap, REAP_WAIT_MS, type StartMinisdOpts } from '../src/minisd/index';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) { try { await f(); } catch { /* 收尾尽力 */ } }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const SYS_ENV = Object.freeze({ SystemRoot: 'C:\\Windows', PATH: 'C:\\bin' });
const TASKKILL = 'C:\\Windows\\System32\\taskkill.exe';
const CWD = tmpdir();

type FakeChild = EventEmitter & {
  pid: number; exitCode: number | null; signalCode: string | null; killed: boolean;
  stdin: PassThrough; stdout: PassThrough; stderr: PassThrough;
  kills: Array<NodeJS.Signals | number | undefined>;
  kill: (sig?: NodeJS.Signals | number) => boolean;
};
interface Spawned { cmd: string; args: string[]; opts: Record<string, unknown>; child?: FakeChild; tk?: EventEmitter }

/** 假 spawn：taskkill 返回空的 EventEmitter（用例手动 emit exit / error；autoExit 打开后新起的 taskkill 下一拍自己以 0 退出），
 *  其余返回带三条 PassThrough 的假子进程，pid 从 7000 递增，下一个微任务 emit('spawn')。 */
function fakeSpawn() {
  const spawned: Spawned[] = [];
  const children: FakeChild[] = [];
  const taskkills: EventEmitter[] = [];
  let nextPid = 7000;
  const state = { autoExit: false };
  const spawnImpl = ((cmd: string, args: string[], opts: Record<string, unknown>) => {
    const rec: Spawned = { cmd, args: [...args], opts };
    spawned.push(rec);
    if (/taskkill\.exe$/i.test(cmd)) {
      const tk = new EventEmitter();
      rec.tk = tk;
      taskkills.push(tk);
      if (state.autoExit) setImmediate(() => tk.emit('exit', 0, null));
      return tk;
    }
    const ch = new EventEmitter() as FakeChild;
    Object.assign(ch, {
      pid: nextPid++, exitCode: null, signalCode: null, killed: false,
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kills: [],
    });
    ch.kill = (sig) => { ch.kills.push(sig); return true; };
    // 兼当 PowerShell 驱动（一行「marker base64」→ 完成哨兵，退出码 0）与 MCP server（带 id 的 JSON-RPC 请求 → 空结果）
    let buf = '';
    ch.stdin.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.startsWith('{')) {
          const msg = JSON.parse(line) as { id?: unknown };
          if (msg.id !== undefined) ch.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\n');
        } else if (line) {
          ch.stdout.write(`__MINIS_DONE_${line.split(' ')[0]}_EXIT_0__\n`);
        }
      }
    });
    rec.child = ch;
    children.push(ch);
    queueMicrotask(() => ch.emit('spawn'));
    return ch;
  }) as unknown as typeof spawn;
  /** 收某个假子进程的那一次 taskkill（按 /pid 参数认） */
  const taskkillOf = (ch: FakeChild): EventEmitter => {
    const hit = spawned.find(s => s.tk && s.args[1] === String(ch.pid));
    if (!hit?.tk) throw new Error(`没有对 pid ${ch.pid} 起 taskkill`);
    return hit.tk;
  };
  const taskkillPids = (): string[] => spawned.filter(s => s.tk).map(s => s.args[1]);
  /** 放行：已起的 taskkill 全部以 0 退出，之后新起的自己退出（收尾用，免得关停等满上限） */
  const releaseAll = (): void => { state.autoExit = true; for (const tk of taskkills) tk.emit('exit', 0, null); };
  return { spawned, children, taskkills, spawnImpl, taskkillOf, taskkillPids, releaseAll };
}
const win = (spawnImpl: typeof spawn) => ({ platform: 'win32', spawnImpl, sysEnv: SYS_ENV });
/** 排空微任务与已到期的 I/O 回调 */
const drain = (): Promise<void> => new Promise((r) => setImmediate(r));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** 看一个 promise 落没落定（落定后 done() 为真，promise 原样带出来 await） */
function watch<T>(p: Promise<T>): { done: () => boolean; promise: Promise<T> } {
  let done = false;
  void p.then(() => { done = true; }, () => { done = true; });
  return { done: () => done, promise: p };
}
/** 读退出码就抛：让某个会话的回收同步抛错（killTree 第一步就读它） */
function poisonExitCode(ch: FakeChild): void {
  Object.defineProperty(ch, 'exitCode', { get() { throw new Error('注入：读退出码抛错'); } });
}

describe('终端：disposeAll 返回全部回收落定的 Promise', () => {
  function mgrWithTwo() {
    const f = fakeSpawn();
    const paths = new MinisPaths(mkdtempSync(join(tmpdir(), 'dm-reap-term-')));
    const mgr = new TerminalManager(paths, () => {}, undefined, win(f.spawnImpl));
    const [s1, s2] = [randomUUID(), randomUUID()];
    mgr.attach(s1);
    mgr.attach(s2);
    return { f, mgr, s1, s2 };
  }

  it('两个会话都起 taskkill；两个都退出之前不落定', async () => {
    const { f, mgr } = mgrWithTwo();
    const w = watch(mgr.disposeAll());
    expect(f.taskkillPids()).toEqual(f.children.map(c => String(c.pid)));
    expect(f.spawned.filter(s => s.tk).every(s => s.cmd === TASKKILL)).toBe(true);
    await drain();
    expect(w.done()).toBe(false);
    f.taskkillOf(f.children[0]).emit('exit', 0, null);
    await drain();
    expect(w.done(), '只收完一个会话就落定了').toBe(false);
    f.taskkillOf(f.children[1]).emit('exit', 0, null);
    await expect(w.promise).resolves.toBeUndefined();
  });

  it('一个会话的回收同步抛错：disposeAll 不抛，其余会话照样回收，等它们落定', async () => {
    const { f, mgr } = mgrWithTwo();
    poisonExitCode(f.children[0]);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let p: Promise<void> | undefined;
    expect(() => { p = mgr.disposeAll(); }).not.toThrow();
    expect(f.taskkillPids(), '第一个会话抛错后，第二个会话没有回收').toEqual([String(f.children[1].pid)]);
    const w = watch(p!);
    await drain();
    expect(w.done()).toBe(false);
    f.taskkillOf(f.children[1]).emit('exit', 0, null);
    await expect(w.promise).resolves.toBeUndefined();
  });

  it('单个会话的 dispose 也返回回收落定的 Promise（删除会话不等它，行为不变）', async () => {
    const { f, mgr, s1 } = mgrWithTwo();
    const w = watch(mgr.dispose(s1));
    await drain();
    expect(w.done()).toBe(false);
    f.taskkillOf(f.children[0]).emit('exit', 0, null);
    await expect(w.promise).resolves.toBeUndefined();
    await expect(mgr.dispose('不存在的会话')).resolves.toBeUndefined();

    const g = fakeSpawn();
    const t = new TerminalSession(CWD, () => {}, {}, win(g.spawnImpl));
    t.attach();
    const wt = watch(t.dispose());
    await drain();
    expect(wt.done()).toBe(false);
    g.taskkillOf(g.children[0]).emit('exit', 1, null);
    await wt.promise;
    expect(g.children[0].kills).toEqual(['SIGKILL']);
  });
});

describe('shell：disposeAll 返回全部回收落定的 Promise', () => {
  async function mgrWithTwo() {
    const f = fakeSpawn();
    const mgr = new ShellManager(win(f.spawnImpl));
    // 假驱动当场回完成哨兵：两条命令都跑完，两个会话各留一个常驻驱动
    await mgr.run('S1', CWD, 'Get-Date');
    await mgr.run('S2', CWD, 'Get-Date');
    expect(f.children).toHaveLength(2);
    return { f, mgr };
  }

  it('两个会话的驱动都起 taskkill；两个都退出之前不落定', async () => {
    const { f, mgr } = await mgrWithTwo();
    const w = watch(mgr.disposeAll());
    expect(f.taskkillPids()).toEqual(f.children.map(c => String(c.pid)));
    await drain();
    expect(w.done()).toBe(false);
    f.taskkillOf(f.children[1]).emit('exit', 0, null);
    await drain();
    expect(w.done(), '只收完一个会话就落定了').toBe(false);
    f.taskkillOf(f.children[0]).emit('error', new Error('spawn EPERM'));
    await expect(w.promise).resolves.toBeUndefined();
    expect(f.children[0].kills).toEqual(['SIGKILL']);
  });

  it('一个会话的回收同步抛错：disposeAll 不抛，其余会话照样回收，等它们落定', async () => {
    const { f, mgr } = await mgrWithTwo();
    poisonExitCode(f.children[0]);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let p: Promise<void> | undefined;
    expect(() => { p = mgr.disposeAll(); }).not.toThrow();
    expect(f.taskkillPids()).toEqual([String(f.children[1].pid)]);
    const w = watch(p!);
    await drain();
    expect(w.done()).toBe(false);
    f.taskkillOf(f.children[1]).emit('exit', 0, null);
    await expect(w.promise).resolves.toBeUndefined();
  });

  it('单个会话的 dispose 也返回回收落定的 Promise；interrupt 照旧不等', async () => {
    const { f, mgr } = await mgrWithTwo();
    const w = watch(mgr.dispose('S1'));
    await drain();
    expect(w.done()).toBe(false);
    f.taskkillOf(f.children[0]).emit('exit', 0, null);
    await expect(w.promise).resolves.toBeUndefined();
    await expect(mgr.dispose('S-unknown')).resolves.toBeUndefined();
    expect(mgr.interrupt('S2')).toBeUndefined();
    expect(f.taskkillPids()).toContain(String(f.children[1].pid));

    const g = fakeSpawn();
    const sh = new PersistentShell(CWD, undefined, win(g.spawnImpl));
    await sh.run('Get-Date');
    const ws = watch(sh.dispose());
    await drain();
    expect(ws.done()).toBe(false);
    g.taskkillOf(g.children[0]).emit('exit', 0, null);
    await expect(ws.promise).resolves.toBeUndefined();
  });
});

describe('MCP：client.dispose 与 McpManager.disposeAll 返回回收落定的 Promise', () => {
  it('stdio：dispose 在 taskkill 退出之后才落定；再调一次拿到同一个 promise', async () => {
    const f = fakeSpawn();
    const c = new McpStdioClient({ command: 'dm-fake-mcp', startupTimeoutSeconds: 5, proc: win(f.spawnImpl) });
    await c.connect(); // 假 server 当场应答握手
    const p1 = c.dispose();
    const w = watch(p1);
    expect(f.taskkillPids()).toEqual([String(f.children[0].pid)]);
    expect(c.dispose(), '幂等：第二次拿到同一个 promise，不再起第二个 taskkill').toBe(p1);
    expect(f.taskkills).toHaveLength(1);
    await drain();
    expect(w.done()).toBe(false);
    f.taskkills[0].emit('exit', 0, null);
    await expect(w.promise).resolves.toBeUndefined();

    // 从没连上（没有子进程）：立即落定
    await expect(new McpStdioClient({ command: 'x', proc: win(fakeSpawn().spawnImpl) }).dispose()).resolves.toBeUndefined();
  });

  it('http：有会话时等 DELETE 告别落定（成败都算，不拒绝）；没有会话时立即落定', async () => {
    let answerDelete!: (r: Response) => void;
    let failDelete!: (e: Error) => void;
    const mkFetch = (sessionId: string | null, del: 'hold' | 'fail') => (async (_input: unknown, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return new Promise<Response>((res, rej) => { if (del === 'hold') answerDelete = res; else failDelete = rej; });
      }
      const body = JSON.parse(String(init?.body)) as { id?: number };
      if (body.id === undefined) return new Response('', { status: 202 });
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (sessionId) headers['mcp-session-id'] = sessionId;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }), { headers });
    }) as typeof fetch;

    const a = new McpHttpClient({ url: 'https://mcp.example/rpc' }, mkFetch('sess-a', 'hold'));
    await a.connect();
    const wa = watch(a.dispose());
    await drain();
    expect(wa.done(), 'DELETE 还没回来就落定了').toBe(false);
    expect(a.dispose(), '幂等：第二次拿到同一个 promise').toBe(wa.promise);
    answerDelete(new Response('', { status: 200 }));
    await expect(wa.promise).resolves.toBeUndefined();

    const b = new McpHttpClient({ url: 'https://mcp.example/rpc' }, mkFetch('sess-b', 'fail'));
    await b.connect();
    const wb = watch(b.dispose());
    await drain();
    expect(wb.done()).toBe(false);
    failDelete(new Error('ECONNRESET'));
    await expect(wb.promise).resolves.toBeUndefined();

    const n = new McpHttpClient({ url: 'https://mcp.example/rpc' }, mkFetch(null, 'hold'));
    await n.connect();
    const wn = watch(n.dispose());
    await drain();
    expect(wn.done(), '没有会话、不发告别：立即落定').toBe(true);
  });

  /** 与真 client 同形的假客户端：dispose 返回用例手里的 promise，或同步抛错 */
  class ReapClient implements McpClientLike {
    onNotification: ((n: McpNotification) => void) | undefined;
    closed = false;
    disposeCalls = 0;
    throwOnDispose = false;
    release!: () => void;
    private readonly reaped = new Promise<void>(r => { this.release = r; });
    async connect(): Promise<void> {}
    async listTools(): Promise<McpToolInfo[]> { return [{ name: 'echo', inputSchema: { type: 'object', properties: {} } }]; }
    async callTool(): Promise<unknown> { return { content: [] }; }
    dispose(): Promise<void> {
      this.disposeCalls++;
      if (this.throwOnDispose) throw new Error('注入：dispose 抛错');
      return this.reaped;
    }
  }

  async function managerWith(names: string[]) {
    const store = new McpServersStore(new MinisPaths(mkdtempSync(join(tmpdir(), 'dm-reap-mcp-'))));
    for (const name of names) store.upsert({ name, command: 'echo', args: [], enabled: true });
    const clients = new Map<string, ReapClient>();
    const mgr = new McpManager({
      store, chatStore: new ChatStore(openDb(':memory:')), registry: new ToolRegistry(),
      factories: entry => { const c = new ReapClient(); clients.set(entry.name, c); return c; },
    });
    await mgr.ensureForRun();
    return { mgr, clients };
  }

  it('disposeAll：每台都当场 dispose，全部落定才落定；状态复位为 idle', async () => {
    const { mgr, clients } = await managerWith(['a', 'b']);
    const w = watch(mgr.disposeAll());
    expect([...clients.values()].map(c => c.disposeCalls)).toEqual([1, 1]);
    expect(mgr.statuses().map(s => s.status)).toEqual(['idle', 'idle']);
    await drain();
    expect(w.done()).toBe(false);
    clients.get('a')!.release();
    await drain();
    expect(w.done(), '只断开一台就落定了').toBe(false);
    clients.get('b')!.release();
    await expect(w.promise).resolves.toBeUndefined();
  });

  it('disposeAll：一台同步抛错，其余照样断开、状态照样复位；disposeAll 不抛', async () => {
    const { mgr, clients } = await managerWith(['a', 'b']);
    clients.get('a')!.throwOnDispose = true;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let p: Promise<void> | undefined;
    expect(() => { p = mgr.disposeAll(); }).not.toThrow();
    expect(clients.get('b')!.disposeCalls).toBe(1);
    expect(mgr.statuses().map(s => s.status)).toEqual(['idle', 'idle']);
    const w = watch(p!);
    await drain();
    expect(w.done()).toBe(false);
    clients.get('b')!.release();
    await expect(w.promise).resolves.toBeUndefined();
  });
});

describe('shutdownReap：关停第 6 步（各自兜住地发起，一起等，最多等 limitMs）', () => {
  function deferred() {
    let resolve!: () => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  }

  it('三步都当场发起；全部落定才返回 done，一步没落定就不返回', async () => {
    const [a, b, c] = [deferred(), deferred(), deferred()];
    const order: string[] = [];
    const w = watch(shutdownReap([
      ['销毁终端', () => { order.push('a'); return a.promise; }],
      ['销毁 shell', () => { order.push('b'); return b.promise; }],
      ['断开 MCP', () => { order.push('c'); return c.promise; }],
    ], 10_000));
    expect(order, '三步要当场逐个发起，不能等上一步落定才发起下一步').toEqual(['a', 'b', 'c']);
    a.resolve(); c.resolve();
    await drain();
    expect(w.done()).toBe(false);
    b.resolve();
    await expect(w.promise).resolves.toBe('done');
  });

  it('一步同步抛错：只记一笔，其余两步照样发起、照样等', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const [b, c] = [deferred(), deferred()];
    const called: string[] = [];
    const w = watch(shutdownReap([
      ['销毁终端', () => { called.push('a'); throw new Error('注入：终端抛错'); }],
      ['销毁 shell', () => { called.push('b'); return b.promise; }],
      ['断开 MCP', () => { called.push('c'); return c.promise; }],
    ], 10_000));
    expect(called).toEqual(['a', 'b', 'c']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('销毁终端');
    b.resolve();
    await drain();
    expect(w.done(), '抛错那一步不该让等待提前结束').toBe(false);
    c.resolve();
    await expect(w.promise).resolves.toBe('done');
  });

  it('一步返回的 promise 拒绝：记一笔，不打断对其余步骤的等待', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const [a, b] = [deferred(), deferred()];
    const w = watch(shutdownReap([
      ['销毁终端', () => a.promise],
      ['销毁 shell', () => b.promise],
      ['断开 MCP', () => undefined],
    ], 10_000));
    a.reject(new Error('注入：回收失败'));
    await drain();
    expect(w.done()).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    b.resolve();
    await expect(w.promise).resolves.toBe('done');
  });

  it('有一步永不落定：到 limitMs 返回 timeout，照样往下走（记一笔）', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const w = watch(shutdownReap([
      ['销毁终端', () => new Promise<void>(() => { /* taskkill 卡住 */ })],
      ['销毁 shell', () => Promise.resolve()],
    ], 1000));
    await vi.advanceTimersByTimeAsync(999);
    expect(w.done()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(w.promise).resolves.toBe('timeout');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

// ── 进程内 minisd：关停第 6 步真的在等 ─────────────────────────────────────────

function rpcClient(port: number, token: string) {
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
  function call(method: string, params?: unknown, timeoutMs = 4000): Promise<any> {
    const id = ++idc;
    return new Promise((res) => {
      const t = setTimeout(() => { pending.delete(id); res({ error: { message: `无应答（${method}）` } }); }, timeoutMs);
      pending.set(id, (v) => { clearTimeout(t); res(v); });
      try { ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); } catch { /* 连接已断：等时限 */ }
    });
  }
  return { ready, call, notifications, close: () => ws.close() };
}

async function waitFor(what: string, cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await sleep(10);
  }
}

/** 起一个进程内 minisd，终端与 shell 的子进程全走假 spawn（按 win32 走 taskkill）。
 *  收尾先放行全部 taskkill 再 close：用例中途失败时，关停不必等满上限。 */
async function bootWin(extra: Partial<StartMinisdOpts> = {}) {
  const f = fakeSpawn();
  const dataDir = mkdtempSync(join(tmpdir(), 'dm-reap-'));
  process.env.DESKMINIS_TEST = '1';
  process.env.DESKMINIS_FAKE_PROVIDER = '1';
  const srv = await startMinisd({ dataDir, host: '127.0.0.1', port: 0, proc: win(f.spawnImpl), ...extra });
  cleanups.push(async () => { f.releaseAll(); await srv.close(); });
  const c = rpcClient(srv.port, srv.authToken);
  await c.ready;
  cleanups.push(() => c.close());
  const paths = new MinisPaths(dataDir);
  const lock = join(dataDir, DATA_ROOT_LOCK_NAME);
  /** 某个会话工作区里起的那个假子进程（终端与 shell 都以会话工作区为 cwd） */
  const childIn = (sessionId: string, cmdRe: RegExp): FakeChild => {
    const hit = f.spawned.find(s => s.child && s.opts.cwd === paths.workspaceOf(sessionId) && cmdRe.test(s.cmd));
    if (!hit?.child) throw new Error(`会话 ${sessionId} 里没有起过子进程`);
    return hit.child;
  };
  return { srv, dataDir, c, f, lock, childIn };
}

type Booted = Awaited<ReturnType<typeof bootWin>>;
const PS_RE = /WindowsPowerShell\\v1\.0\\powershell\.exe$/;

/** 开一个会话并打开它的终端（假 PowerShell 常驻） */
async function openTerminal(b: Booted): Promise<FakeChild> {
  const s = (await b.c.call('chat.sessions.create', {})).result;
  expect((await b.c.call('terminal.attach', { sessionId: s.id })).error).toBeUndefined();
  return b.childIn(s.id, PS_RE);
}

/** 开一个会话，让 agent 用 shell_execute 跑一条只读命令（免批），跑完留下常驻驱动 */
async function runShell(b: Booted): Promise<FakeChild> {
  const s = (await b.c.call('chat.sessions.create', {})).result;
  const text = `__tool__ shell_execute ${JSON.stringify({ command: 'Get-Date', tool_title: '看时间' })}`;
  expect((await b.c.call('chat.prompt', { sessionId: s.id, providerId: '__fake__', text })).error).toBeUndefined();
  await waitFor('shell 回合跑完', () => b.c.notifications.some(n => n.method === 'chat.event' && n.params.sessionId === s.id
    && n.params.event.kind === 'turnEnd' && n.params.event.stopReason === 'endTurn'));
  const ends = b.c.notifications.filter(n => n.method === 'chat.event' && n.params.sessionId === s.id && n.params.event.kind === 'toolEnd');
  expect(ends.map(n => n.params.event.success), '假驱动应让命令成功跑完').toEqual([true]);
  return b.childIn(s.id, PS_RE);
}

describe('W1b-5d 进程内 minisd：关停等进程树回收做完再关库放锁', () => {
  it('终端与 shell 各有一棵树：两边的 taskkill 都退出之前 close 不落定、锁不放；都退出后才关完', async () => {
    const b = await bootWin({ reapWaitMs: 20_000 }); // 上限放宽：只看「等不等」，不让上限替它落定
    const term = await openTerminal(b);
    const shell = await runShell(b);

    const w = watch(b.srv.close());
    await waitFor('两棵树的 taskkill 都起了', () => b.f.taskkills.length === 2);
    expect(b.f.taskkillPids().sort()).toEqual([term.pid, shell.pid].map(String).sort());
    await sleep(100);
    expect(w.done(), 'taskkill 还没跑完 close 就落定了：standalone 会随即 exit(0)，还没收的孙进程成孤儿').toBe(false);
    expect(existsSync(b.lock), '收树还没做完就关库放锁了').toBe(true);

    b.f.taskkillOf(term).emit('exit', 0, null);
    await sleep(100);
    expect(w.done(), '只等了终端、没等 shell').toBe(false);
    expect(existsSync(b.lock)).toBe(true);

    b.f.taskkillOf(shell).emit('exit', 1, null); // 没杀干净：先兜底杀根，再落定
    await w.promise;
    expect(shell.kills).toEqual(['SIGKILL']);
    expect(existsSync(b.lock), '关完了锁还在').toBe(false);
    // 库已关、锁已放：同一个根在本进程里能再起
    const again = await startMinisd({ dataDir: b.dataDir, host: '127.0.0.1', port: 0 });
    await again.close();
  }, 30000);

  it('终端里一个会话的回收同步抛错：其余会话与 shell 照样回收并被等，关库放锁照做', async () => {
    const b = await bootWin({ reapWaitMs: 20_000 });
    const bad = await openTerminal(b);
    const good = await openTerminal(b);
    const shell = await runShell(b);
    poisonExitCode(bad);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const w = watch(b.srv.close());
    await waitFor('其余两棵树的 taskkill', () => b.f.taskkills.length === 2);
    expect(b.f.taskkillPids().sort(), '抛错的会话之后，别的会话、shell 都还要回收').toEqual([good.pid, shell.pid].map(String).sort());
    await sleep(100);
    expect(w.done()).toBe(false);
    b.f.taskkillOf(good).emit('exit', 0, null);
    b.f.taskkillOf(shell).emit('exit', 0, null);
    await w.promise;
    expect(existsSync(b.lock)).toBe(false);
  }, 30000);

  /** 关停记下的「等回收超时」那一笔（按上限认：用的是哪个上限，就看这一笔写的是多少毫秒） */
  const timeoutNotes = (warn: { mock: { calls: unknown[][] } }) =>
    warn.mock.calls.map(c => String(c[0])).filter(s => s.includes('等子进程树回收超过'));

  it('taskkill 迟迟不退：等满上限（注入 reapWaitMs）照样关库放锁，并记一笔', async () => {
    const b = await bootWin({ reapWaitMs: 150 });
    await openTerminal(b);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t0 = Date.now();
    await b.srv.close();
    const took = Date.now() - t0;
    expect(b.f.taskkills).toHaveLength(1);
    expect(took, '没等满上限就往下关了').toBeGreaterThanOrEqual(140);
    expect(timeoutNotes(warn), '用的是注入的上限').toEqual([expect.stringContaining('超过 150ms')]);
    expect(existsSync(b.lock)).toBe(false);
  }, 30000);

  it('不注入时上限就是 REAP_WAIT_MS', async () => {
    const b = await bootWin();
    await openTerminal(b);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t0 = Date.now();
    await b.srv.close();
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(REAP_WAIT_MS - 20);
    expect(took).toBeLessThan(REAP_WAIT_MS + 2000);
    expect(timeoutNotes(warn)).toEqual([expect.stringContaining(`超过 ${REAP_WAIT_MS}ms`)]);
    expect(existsSync(b.lock)).toBe(false);
  }, 30000);
});
