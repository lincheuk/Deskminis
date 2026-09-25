/**
 * W1b-4（设计稿 §4 S12 · lifecycle.md W1b-delete）：删除运行中的会话先中止、等收尾，再删。
 *
 * 旧实现 chat.sessions.delete 是同步的：只销毁终端、删库，既不唤醒挂着的权限卡，也不 abort 正在跑的 run——
 * 用户在删完之后再点「允许」，工具照样出网 / 写文件，loop 还会把 toolResult 与后续回复写进已删会话，留下孤儿行。
 * 定时任务那一半（cross.md missing）：loop 失败是 yield error 事件后正常返回、不 throw，IIFE 的 catch 抓不到，
 * 完成钩子拿到的 err 恒为 undefined，失败的运行被记成 last_status='ok'。
 *
 * 权限卡用 web_fetch 触发（askOnce，放行前不出网）；不用 POSIX 绝对路径的 file_write——
 * paths.ts 在 Linux 上对它直接抛错，走不到权限网关（cross.md corrections）。
 * 出网与否由本地计数服务器判定：它收到过请求，就说明删除之后工具还是跑了。
 *
 * W1b-4b（W1b-4 第三轮审查）：删除只能了结 / 中止被删的那个会话。单会话用例对「按会话过滤」写错毫无感知，
 * 双会话一例把它钉住；它不是先红，靠 deny-all、abort-all 两个变异证明抓得住。
 */
import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMinisd } from '../src/minisd/index';
import { stripComments } from './strip-comments';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) { try { await f(); } catch { /* 收尾尽力 */ } }
});

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
  const ready = new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
  function call(method: string, params?: unknown): Promise<any> {
    const id = ++idc;
    return new Promise((res) => { pending.set(id, res); ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); });
  }
  return { ready, call, notifications, close: () => ws.close() };
}

/** 起一个进程内 minisd。seed 在启动前往数据根里铺文件（providers.json / servers.json）。 */
async function boot(opts: { permTimeoutMs?: number; runStopTimeoutMs?: number } = {}, seed?: (dir: string) => void) {
  const dataDir = mkdtempSync(join(tmpdir(), 'dm-del-run-'));
  seed?.(dataDir);
  process.env.DESKMINIS_TEST = '1';
  process.env.DESKMINIS_FAKE_PROVIDER = '1';
  const srv = await startMinisd({ dataDir, host: '127.0.0.1', port: 0, permTimeoutMs: 60000, ...opts });
  cleanups.push(() => srv.close());
  const c = rpcClient(srv.port, srv.authToken);
  await c.ready;
  cleanups.push(() => c.close());
  return { ...srv, dataDir, c };
}

async function waitFor(what: string, cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise(r => setTimeout(r, 10));
  }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function toolScript(name: string, input: Record<string, unknown>): string {
  return `__tool__ ${name} ${JSON.stringify(input)}`;
}

/** 本地 HTTP 服务器。hang=true 时收下请求永不应答（模拟连不上的 MCP：卡在握手直到启动超时）。 */
async function localServer(hang: boolean): Promise<{ url: string; hits: () => number; server: Server }> {
  let n = 0;
  const server = createServer((req, res) => {
    n++;
    if (hang) return; // 不应答：客户端只能等自己的超时
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('抓到了');
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  cleanups.push(() => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/mcp`, hits: () => n, server };
}

/** 往数据根铺一台 streamable-http 的 MCP：握手永远等不到应答，ensureForRun 会卡满 startupTimeoutSeconds。 */
function seedHangingMcp(url: string, startupTimeoutSeconds: number) {
  return (dir: string) => {
    mkdirSync(join(dir, 'mcp-servers'), { recursive: true });
    writeFileSync(join(dir, 'mcp-servers', 'servers.json'), JSON.stringify({ mcpServers: { hang: { url, startupTimeoutSeconds } } }), 'utf8');
  };
}

describe('W1b-4 删除运行中的会话：先中止、等收尾、再删', () => {
  it('权限卡挂着时删除：卡片按 session-deleted 了结，删后再批准也不出网，会话里不留孤儿消息', async () => {
    const { c } = await boot();
    const target = await localServer(false);
    const s = (await c.call('chat.sessions.create', {})).result;
    const url = target.url.replace('/mcp', '/page');
    await c.call('chat.prompt', { sessionId: s.id, providerId: '__fake__', text: toolScript('web_fetch', { url, tool_title: '抓网页' }) });
    await waitFor('permission.request', () => c.notifications.some(n => n.method === 'permission.request'));
    const requestId = c.notifications.find(n => n.method === 'permission.request')!.params.requestId;

    const del = await c.call('chat.sessions.delete', { sessionId: s.id, confirm: true });
    expect(del.error).toBeUndefined();
    expect(del.result).toEqual({ ok: true });
    // 删除之后才点「允许」：卡早该了结，这次批准不能再让工具跑起来
    await c.call('permission.respond', { requestId, decision: 'allow-once' });
    await sleep(300);

    expect(c.notifications.some(n => n.method === 'permission.resolved' && n.params.requestId === requestId && n.params.reason === 'session-deleted')).toBe(true);
    expect(target.hits()).toBe(0);
    expect((await c.call('chat.messages.list', { sessionId: s.id })).result).toEqual([]);
    expect((await c.call('chat.sessions.list')).result.some((x: any) => x.id === s.id)).toBe(false);
    // 多窗口：删除要广播，别的窗口靠它重拉左栏
    expect(c.notifications.some(n => n.method === 'chat.sessions.changed')).toBe(true);
  }, 30000);

  it('chat.prompt 卡在 ensureForRun（MCP 连接中）时删除：等它收尾，user 消息不落进已删会话', async () => {
    const mcp = await localServer(true);
    const { c } = await boot({}, seedHangingMcp(mcp.url, 1.5));
    const s = (await c.call('chat.sessions.create', {})).result;
    const prompting = c.call('chat.prompt', { sessionId: s.id, providerId: '__fake__', text: '你好' });
    await waitFor('MCP 握手请求到达（prompt 正卡在 ensureForRun）', () => mcp.hits() > 0);

    const del = await c.call('chat.sessions.delete', { sessionId: s.id, confirm: true });
    expect(del.error).toBeUndefined();
    const pr = await prompting;
    expect(pr.error?.message ?? '').toContain('会话已取消');
    await sleep(300);
    expect((await c.call('chat.messages.list', { sessionId: s.id })).result).toEqual([]);
    expect((await c.call('chat.sessions.list')).result.some((x: any) => x.id === s.id)).toBe(false);
  }, 30000);

  it('收尾超时（run 迟迟停不下来）就不删并报错；停下来之后再删成功', async () => {
    const mcp = await localServer(true);
    const { c } = await boot({ runStopTimeoutMs: 200 }, seedHangingMcp(mcp.url, 2));
    const s = (await c.call('chat.sessions.create', {})).result;
    const prompting = c.call('chat.prompt', { sessionId: s.id, providerId: '__fake__', text: '你好' });
    await waitFor('MCP 握手请求到达', () => mcp.hits() > 0);

    const del = await c.call('chat.sessions.delete', { sessionId: s.id, confirm: true });
    expect(del.error?.message ?? '').toContain('会话仍在停止中，请稍后再删');
    // 没删：会话还在
    expect((await c.call('chat.sessions.list')).result.some((x: any) => x.id === s.id)).toBe(true);

    // 等 run 自己收尾（MCP 启动超时后看到已中止，不落 user 消息）
    const pr = await prompting;
    expect(pr.error?.message ?? '').toContain('会话已取消');
    const again = await c.call('chat.sessions.delete', { sessionId: s.id, confirm: true });
    expect(again.error).toBeUndefined();
    expect((await c.call('chat.messages.list', { sessionId: s.id })).result).toEqual([]);
    expect((await c.call('chat.sessions.list')).result.some((x: any) => x.id === s.id)).toBe(false);
  }, 30000);
});

describe('W1b-4b 删除只动被删的会话（双会话隔离，回归钉）', () => {
  // 上面三例都只有一个会话：denyPendingPerms 丢了按会话过滤、stopRun 改成把所有 controller 都 abort，它们照样全绿。
  // 这两个函数同时被 close() 以 'all' / 全部会话复用（W1b-5），过滤写错一处，删一个会话就会连带拒掉别的会话
  // 正等用户批准的操作、掐断别的会话正在跑的回复——用户看到的是「我没动的那个会话莫名报已取消」。
  // A、B 各指向自己的计数服务器，出网落在哪台上就知道是谁的工具跑了，不会把 A 的漏网误算成 B 照常。
  it('A、B 各挂一张卡，删 A：只了结 A 的卡；B 的卡原样待批，批准后 B 照常出网并跑完，不报错', async () => {
    const { c } = await boot();
    const siteA = await localServer(false);
    const siteB = await localServer(false);
    const a = (await c.call('chat.sessions.create', {})).result;
    const b = (await c.call('chat.sessions.create', {})).result;
    await c.call('chat.prompt', { sessionId: a.id, providerId: '__fake__', text: toolScript('web_fetch', { url: siteA.url.replace('/mcp', '/page'), tool_title: 'A 抓网页' }) });
    await c.call('chat.prompt', { sessionId: b.id, providerId: '__fake__', text: toolScript('web_fetch', { url: siteB.url.replace('/mcp', '/page'), tool_title: 'B 抓网页' }) });
    const cardOf = (sid: string) => c.notifications.find(n => n.method === 'permission.request' && n.params.req.sessionId === sid);
    await waitFor('A、B 各一张权限卡', () => !!cardOf(a.id) && !!cardOf(b.id));
    const reqA = cardOf(a.id)!.params.requestId;
    const reqB = cardOf(b.id)!.params.requestId;
    const resolvedOf = (rid: string) => c.notifications.filter(n => n.method === 'permission.resolved' && n.params.requestId === rid);

    expect((await c.call('chat.sessions.delete', { sessionId: a.id, confirm: true })).error).toBeUndefined();
    // 了结是同步广播、先于删除的应答发出；多等一会儿，是给以后可能改成异步的了结留余量
    await sleep(200);
    expect(resolvedOf(reqA).map(n => n.params.reason)).toEqual(['session-deleted']);
    expect(resolvedOf(reqB)).toEqual([]);

    // permission.respond 对不存在的 requestId 也回 ok，光看应答分不出卡还在不在；
    // 以 answered 广播为准：只有卡仍挂在 pendingPerms 里，批准才会广播 answered
    expect((await c.call('permission.respond', { requestId: reqB, decision: 'allow-once' })).error).toBeUndefined();
    await waitFor('B 的卡按 answered 了结', () => resolvedOf(reqB).some(n => n.params.reason === 'answered'));
    await waitFor('B 出网', () => siteB.hits() === 1);
    await waitFor('B 跑完', () => c.notifications.some(n => n.method === 'chat.event' && n.params.sessionId === b.id
      && n.params.event.kind === 'turnEnd' && n.params.event.stopReason === 'endTurn'));

    const eventsB = c.notifications.filter(n => n.method === 'chat.event' && n.params.sessionId === b.id).map(n => n.params.event);
    expect(eventsB.filter(e => e.kind === 'error')).toEqual([]);
    expect(eventsB.filter(e => e.kind === 'toolEnd').map(e => e.success)).toEqual([true]);
    expect(siteA.hits()).toBe(0);
    const left = (await c.call('chat.sessions.list')).result.map((x: any) => x.id);
    expect(left).toContain(b.id);
    expect(left).not.toContain(a.id);
  }, 30000);
});

describe('W1b-4 定时任务的终态如实（cross.md missing：失败不再记为 ok）', () => {
  const fakeDefault = (dir: string) => {
    writeFileSync(join(dir, 'providers.json'), JSON.stringify({ providers: [], defaultProviderId: '__fake__' }), 'utf8');
  };
  /** 建一个任务、立即运行，轮询到它离开 running 态（markRun 先写 running，完成钩子再写终态）。 */
  async function lastStatusAfterRun(c: ReturnType<typeof rpcClient>, prompt: string): Promise<string> {
    const job = (await c.call('cron.create', { name: 't', prompt, scheduleKind: 'interval', scheduleValue: '60' })).result;
    expect((await c.call('cron.runNow', { id: job.id })).error).toBeUndefined();
    let st = '';
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const j = (await c.call('cron.list')).result.find((x: any) => x.id === job.id);
      st = String(j?.lastStatus ?? '');
      if (j?.lastRunAt && st !== 'running') break;
      await sleep(30);
    }
    return st;
  }

  it('FakeProvider __fail__ 经 cron.runNow：last_status 以 error 开头并带原因（旧实现记成 ok）', async () => {
    const { c } = await boot({}, fakeDefault);
    const st = await lastStatusAfterRun(c, '__fail__ 模拟限流');
    expect(st.startsWith('error')).toBe(true);
    expect(st).toContain('模拟限流');
  }, 30000);

  it('正常跑完仍记 ok（只认 error 事件，别把成功也染红）', async () => {
    const { c } = await boot({}, fakeDefault);
    expect(await lastStatusAfterRun(c, '你好')).toBe('ok');
  }, 30000);

  it('定时任务的会话在运行中被删：last_status 记「会话已删除」', async () => {
    const target = await localServer(false);
    const { c } = await boot({}, fakeDefault);
    const job = (await c.call('cron.create', { name: 't', prompt: toolScript('web_fetch', { url: target.url, tool_title: '抓网页' }), scheduleKind: 'interval', scheduleValue: '60' })).result;
    await c.call('cron.runNow', { id: job.id });
    await waitFor('permission.request', () => c.notifications.some(n => n.method === 'permission.request'));
    const sid = c.notifications.find(n => n.method === 'permission.request')!.params.req.sessionId;
    expect((await c.call('chat.sessions.delete', { sessionId: sid, confirm: true })).error).toBeUndefined();
    let st = '';
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      st = String((await c.call('cron.list')).result.find((x: any) => x.id === job.id)?.lastStatus ?? '');
      if (st.startsWith('error') || st === 'ok') break;
      await sleep(30);
    }
    expect(st).toBe('error: 会话已删除');
    expect(target.hits()).toBe(0);
  }, 30000);
});

describe('W1b-4 删除处理器的收尾顺序（源码守卫）', () => {
  // 依赖顺序（cross.md dependencies）：run 收尾 → 终端 / shell 释放 → 删库 → 广播。
  // shell 在 Linux 上起不来（PowerShell），行为测试覆盖不到 ShellManager.dispose 的接线，这里认调用形态；先剥注释。
  const code = stripComments(readFileSync(join(__dirname, '../src/minisd/index.ts'), 'utf8').replace(/\r\n/g, '\n'));
  const body = (code.split("'chat.sessions.delete':")[1] ?? '').split(/\n {4}'[\w.]+':/)[0];

  it('先 await stopRun，再 terminals.dispose → shells.dispose(sessionId) → chat.deleteSession → 广播 chat.sessions.changed', () => {
    const idx = [
      body.search(/await stopRun\(sessionId,/),
      body.search(/terminals\.dispose\(sessionId\)/),
      body.search(/shells\.dispose\(sessionId\)/),
      body.search(/chat\.deleteSession\(sessionId\)/),
      body.search(/rpc\.broadcast\('chat\.sessions\.changed'/),
    ];
    for (const i of idx) expect(i).toBeGreaterThan(-1);
    for (let k = 1; k < idx.length; k++) expect(idx[k]).toBeGreaterThan(idx[k - 1]);
  });

  it('停不下来就抛错，不往下删', () => {
    expect(body).toMatch(/if \(!stopped\) throw new Error\('会话仍在停止中，请稍后再删'\)/);
  });
});
