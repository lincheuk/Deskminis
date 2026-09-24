/**
 * W1b-5（设计稿 §4 S13 · lifecycle.md W1b-quit）：minisd 有序关停。
 *
 * 旧 close() 的顺序是：停同步 → abort 全部 → 挂起的权限只 clearTimeout、不了结 → 销毁终端 / shell / MCP → 关 rpc → 关库。
 * 两个后果：
 *  - 卡在权限上的 run 永远等不到决议（网关要等满兜底时限），toolResult 从没落库；兜底到点后它再往已关的库里写，
 *    报 database connection is not open。重开会话时模型看到一条没有配对结果的 tool_use。
 *  - abort 之后不等 run 收尾就关库：流式中途的半截回复（loop 的 cancelWithPartialReply）能不能落库全看运气。
 * 新顺序：置 closing（新运行一律拒绝）→ 停同步与调度器 → 按 'shutdown' 了结全部权限卡 → abort → 等收尾（上限 graceMs）
 * → 销毁终端 / shell / MCP、关桥与 rpc → 关库 → 释放数据根锁。整个 close 幂等，重复调用拿到同一个 promise。
 *
 * 审查补测：关停途中一步抛错（审计写入失败）不能跳过后面的 abort、关库与放锁；关停用 'all' 复用 denyPendingPerms / stopRun，
 * 删除会话那条按会话过滤的调用点不能被带歪（另一个会话的卡与 run 不受影响）；standalone 收到 shutdown 要等 close 做完才退。
 *
 * 权限卡用 file_write 写 /var/minis/skills/x/SKILL.md 触发（W1b-2 之后技能目录走卡）；
 * 不用 POSIX 绝对路径——paths.ts 在 Linux 上对它直接抛错，走不到网关（设计稿 §1 第 7 条）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import WebSocket from 'ws';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMinisd, closeThenExit, CLOSE_GRACE_MS } from '../src/minisd/index';

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
  ws.on('error', () => { /* 服务端关停时连接被断，属预期 */ });
  const ready = new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
  /** 带应答时限：关停后连接被断，调用永远等不到应答，不能让用例挂死 */
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

/** 起一个进程内 minisd。收尾时再 close 一次：用例自己关过的话，这一次正好验证幂等。 */
async function boot(seed?: (dir: string) => void, dataDir = mkdtempSync(join(tmpdir(), 'dm-shutdown-'))) {
  seed?.(dataDir);
  process.env.DESKMINIS_TEST = '1';
  process.env.DESKMINIS_FAKE_PROVIDER = '1';
  const srv = await startMinisd({ dataDir, host: '127.0.0.1', port: 0, permTimeoutMs: 60000 });
  cleanups.push(() => srv.close());
  const c = rpcClient(srv.port, srv.authToken);
  await c.ready;
  cleanups.push(() => c.close());
  return { srv, dataDir, c };
}

async function waitFor(what: string, cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise(r => setTimeout(r, 10));
  }
}

function toolScript(name: string, input: Record<string, unknown>): string {
  return `__tool__ ${name} ${JSON.stringify(input)}`;
}

type Row = { role: string; parts_json: string; stream_interrupt_count: number };
/** 关停之后直接读库：只认真正落了盘的东西。 */
function readMessages(dataDir: string, sessionId: string): Row[] {
  const db = new Database(join(dataDir, 'minis.db'), { readonly: true });
  try {
    return db.prepare('SELECT role, parts_json, stream_interrupt_count FROM messages WHERE session_id = ? ORDER BY sort_order').all(sessionId) as Row[];
  } finally { db.close(); }
}

/** 审计里某个权限请求的了结原因（关停之后直接读库）。 */
function readResolvedReasons(dataDir: string, requestId: string): string[] {
  const db = new Database(join(dataDir, 'minis.db'), { readonly: true });
  try {
    const rows = db.prepare("SELECT payload_json FROM audit_logs WHERE event_type = 'permission.resolved'").all() as { payload_json: string }[];
    return rows.map(r => JSON.parse(r.payload_json)).filter(p => p.requestId === requestId).map(p => p.reason);
  } finally { db.close(); }
}

/** 本地 HTTP 服务器，按需挂住请求；收尾时强断所有连接。 */
async function localServer(onReq: (path: string, res: ServerResponse) => void): Promise<{ port: number; hits: () => number; server: Server }> {
  let n = 0;
  const server = createServer((req, res) => {
    n++;
    req.resume(); // 请求体不看，读完才会触发 end
    req.on('end', () => onReq(req.url ?? '', res));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  cleanups.push(() => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }));
  return { port: (server.address() as AddressInfo).port, hits: () => n, server };
}

/** 数据根里铺一台 streamable-http 的 MCP：握手永远等不到应答，chat.prompt 会卡在 ensureForRun 直到启动超时（不理会 abort）。 */
function seedHangingMcp(url: string, startupTimeoutSeconds: number) {
  return (dir: string) => {
    mkdirSync(join(dir, 'mcp-servers'), { recursive: true });
    writeFileSync(join(dir, 'mcp-servers', 'servers.json'), JSON.stringify({ mcpServers: { hang: { url, startupTimeoutSeconds } } }), 'utf8');
  };
}

describe('W1b-5 关停时的收尾：run 先了结再关库', () => {
  it('(a) 权限卡挂着时 close：卡按 shutdown 了结，5 秒内关完；库里 tool_use 后面紧跟 [已取消] 的 toolResult；锁已释放', async () => {
    const { srv, dataDir, c } = await boot();
    const s = (await c.call('chat.sessions.create', {})).result;
    await c.call('chat.prompt', { sessionId: s.id, providerId: '__fake__', text: toolScript('file_write', { path: '/var/minis/skills/x/SKILL.md', content: 'x', tool_title: '写技能' }) });
    await waitFor('permission.request', () => c.notifications.some(n => n.method === 'permission.request'));
    const requestId = c.notifications.find(n => n.method === 'permission.request')!.params.requestId;

    const t0 = Date.now();
    await srv.close();
    expect(Date.now() - t0).toBeLessThan(5000);

    const rows = readMessages(dataDir, s.id);
    const iUse = rows.findIndex(r => r.role === 'assistant' && JSON.parse(r.parts_json).some((p: any) => p.type === 'toolUse'));
    expect(iUse, '应有一条带 tool_use 的 assistant 消息').toBeGreaterThan(-1);
    const toolUseId = JSON.parse(rows[iUse].parts_json).find((p: any) => p.type === 'toolUse').value.toolUseId;
    const next = rows[iUse + 1];
    expect(next?.role, 'tool_use 后面必须紧跟一条 user(toolResult)，否则重开会话时请求带着孤儿 tool_use').toBe('user');
    const result = JSON.parse(next.parts_json).find((p: any) => p.type === 'toolResult');
    // 关停不是用户拒绝：结果写「已取消」，不写「被用户拒绝」
    expect(result?.value).toMatchObject({ toolUseId, output: '[已取消]', success: false });

    // 卡片由关停了结（denyPendingPerms：广播 permission.resolved 后写审计）。认审计而不认客户端收到的广播：
    // rpc 随后 terminate 连接，广播能不能在断开前送到客户端是网络时序，不是本步要钉的行为
    expect(readResolvedReasons(dataDir, requestId)).toEqual(['shutdown']);
    // 没批准就没写
    expect(existsSync(join(dataDir, 'skills', 'x', 'SKILL.md'))).toBe(false);

    // 数据根锁已释放：同一个根能再起一个
    const again = await startMinisd({ dataDir, host: '127.0.0.1', port: 0 });
    await again.close();
  }, 30000);

  it('(b) 流式中途 close：半截回复带 stream_interrupt_count=1 落库；没有未处理拒绝、没有「库已关闭」', async () => {
    const hanging: ServerResponse[] = [];
    const llm = await localServer((path, res) => {
      if (!path.endsWith('/chat/completions')) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const chunk = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      chunk({ id: 'm', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] });
      chunk({ id: 'm', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: '这是半截' } }] });
      hanging.push(res); // 不结束：模拟流卡在中途
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => { unhandled.push(e); };
    process.on('unhandledRejection', onUnhandled);
    const notOpen: string[] = [];
    const origError = console.error; const origWarn = console.warn;
    const sniff = (orig: (...a: unknown[]) => void) => (...a: unknown[]) => {
      const s = a.map(String).join(' ');
      if (/not open/i.test(s)) notOpen.push(s);
      orig(...a);
    };
    console.error = sniff(origError); console.warn = sniff(origWarn);
    cleanups.push(() => { process.off('unhandledRejection', onUnhandled); console.error = origError; console.warn = origWarn; });

    const { srv, dataDir, c } = await boot();
    const p = (await c.call('provider.instances.create', { name: '卡住的端点', kind: 'ollama', baseUrl: `http://127.0.0.1:${llm.port}/v1`, modelId: 'mock-hang' })).result;
    const s = (await c.call('chat.sessions.create', {})).result;
    expect((await c.call('chat.prompt', { sessionId: s.id, providerId: p.id, text: '讲个长故事' })).error).toBeUndefined();
    await waitFor('textDelta', () => c.notifications.some(n => n.method === 'chat.event' && n.params?.event?.kind === 'textDelta'));

    await srv.close();
    await new Promise(r => setTimeout(r, 200)); // 给迟到的写入一个露头的机会

    const partial = readMessages(dataDir, s.id).filter(r => r.role === 'assistant');
    expect(partial).toHaveLength(1);
    expect(partial[0].stream_interrupt_count).toBe(1);
    expect(partial[0].parts_json).toContain('这是半截');
    expect(unhandled).toEqual([]);
    expect(notOpen).toEqual([]);
  }, 30000);
});

describe('W1b-5 close 的闸、幂等与等待上限', () => {
  it('(c) 关停进行中（正等一个 run 收尾）：新的 chat.prompt 与 cron.runNow 拒绝并提示「后台正在关闭」', async () => {
    const mcp = await localServer(() => { /* 不应答：握手挂住 */ });
    const { srv, c } = await boot(seedHangingMcp(`http://127.0.0.1:${mcp.port}/mcp`, 2));
    const job = (await c.call('cron.create', { name: 't', prompt: '你好', scheduleKind: 'interval', scheduleValue: '60' })).result;
    const a = (await c.call('chat.sessions.create', {})).result;
    const b = (await c.call('chat.sessions.create', {})).result;
    const prompting = c.call('chat.prompt', { sessionId: a.id, providerId: '__fake__', text: '你好' }, 8000);
    await waitFor('MCP 握手请求到达（a 正卡在 ensureForRun）', () => mcp.hits() > 0);

    const closing = srv.close();
    const pb = await c.call('chat.prompt', { sessionId: b.id, providerId: '__fake__', text: '你好' });
    expect(pb.error?.message ?? '').toContain('后台正在关闭');
    const rn = await c.call('cron.runNow', { id: job.id });
    expect(rn.error?.message ?? '').toContain('后台正在关闭');
    await closing;
    // a 在关停里被中止：ensureForRun 回来后看到已中止，不落 user 消息
    expect((await prompting).error?.message ?? '').toContain('会话已取消');
  }, 30000);

  it('(d) close 幂等：重复调用拿到同一个 promise，关完再调也不抛；关完同一个根能再起', async () => {
    const { srv, dataDir } = await boot();
    const p1 = srv.close();
    const p2 = srv.close();
    expect(p2).toBe(p1);
    await p1;
    await expect(srv.close()).resolves.toBeUndefined();
    const again = await startMinisd({ dataDir, host: '127.0.0.1', port: 0 });
    await again.close();
  }, 30000);

  it('(e) 不理会中止的 run 不会把 close 拖住：最多等 graceMs 就往下关', async () => {
    const mcp = await localServer(() => { /* 不应答：握手挂住 */ });
    const { srv, c } = await boot(seedHangingMcp(`http://127.0.0.1:${mcp.port}/mcp`, 8));
    const s = (await c.call('chat.sessions.create', {})).result;
    void c.call('chat.prompt', { sessionId: s.id, providerId: '__fake__', text: '你好' });
    await waitFor('MCP 握手请求到达', () => mcp.hits() > 0);

    const t0 = Date.now();
    await srv.close({ graceMs: 300 });
    expect(Date.now() - t0).toBeLessThan(2500);
  }, 30000);
});

/** 两个会话各挂一张 file_write 的权限卡（写各自的技能文件）。 */
async function twoPendingCards(c: ReturnType<typeof rpcClient>) {
  const a = (await c.call('chat.sessions.create', {})).result;
  const b = (await c.call('chat.sessions.create', {})).result;
  await c.call('chat.prompt', { sessionId: a.id, providerId: '__fake__', text: toolScript('file_write', { path: '/var/minis/skills/a/SKILL.md', content: 'A', tool_title: '写 A' }) });
  await c.call('chat.prompt', { sessionId: b.id, providerId: '__fake__', text: toolScript('file_write', { path: '/var/minis/skills/b/SKILL.md', content: 'B', tool_title: '写 B' }) });
  await waitFor('两张权限卡', () => c.notifications.filter(n => n.method === 'permission.request').length === 2);
  const reqs = c.notifications.filter(n => n.method === 'permission.request');
  const ra = reqs.find(n => n.params.req.sessionId === a.id)!.params.requestId as string;
  const rb = reqs.find(n => n.params.req.sessionId === b.id)!.params.requestId as string;
  return { a, b, ra, rb };
}

/** 会话里落了库的 toolResult（关停之后直接读库）。 */
function toolResults(dataDir: string, sessionId: string): any[] {
  return readMessages(dataDir, sessionId).flatMap(r => JSON.parse(r.parts_json)).filter((p: any) => p.type === 'toolResult').map((p: any) => p.value);
}

describe('W1b-5 关停途中一步抛错：后面的步骤照做', () => {
  it('(f) 了结权限卡时审计写入失败：两个会话的卡都了结、run 都落 [已取消]；close 不抛；库关、锁放，同一个根在本进程里能再起', async () => {
    const { srv, dataDir, c } = await boot();
    const { a, b } = await twoPendingCards(c);
    // 旁路连接注入故障：此后「权限卡了结」的审计写入一律失败（SQLITE_FULL / SQLITE_BUSY 的替身）
    const side = new Database(join(dataDir, 'minis.db'));
    side.exec(`CREATE TRIGGER inject_audit_fail BEFORE INSERT ON audit_logs WHEN NEW.event_type = 'permission.resolved'
               BEGIN SELECT RAISE(ABORT, '注入：审计写入失败'); END`);
    side.close();

    const err = await srv.close().then(() => undefined, (e: unknown) => e);

    // 先看放锁：旧实现在第 3 步就抛出、跳过 finally，锁留在盘上，本进程里这个根再也打不开
    expect(existsSync(join(dataDir, 'minisd.lock')), '锁文件还在：关停中途抛错跳过了关库放锁').toBe(false);
    expect(err).toBeUndefined();
    // 第一张卡的审计失败不能让后面的卡没人了结、后面的 run 没人 abort
    for (const s of [a, b]) expect(toolResults(dataDir, s.id), `会话 ${s.id}`).toEqual([expect.objectContaining({ output: '[已取消]', success: false })]);
    expect(existsSync(join(dataDir, 'skills', 'a', 'SKILL.md'))).toBe(false);
    expect(existsSync(join(dataDir, 'skills', 'b', 'SKILL.md'))).toBe(false);

    const again = await startMinisd({ dataDir, host: '127.0.0.1', port: 0 });
    await again.close();
  }, 30000);
});

describe('W1b-5 复用 denyPendingPerms / stopRun 之后，删除会话那条按会话过滤的调用点不变', () => {
  it('(g) 两个会话都挂着卡时删 A：只了结 A 的卡、只停 A 的 run；B 的卡还在，批准后照常写入', async () => {
    const { dataDir, c } = await boot();
    const { a, b, ra, rb } = await twoPendingCards(c);

    const del = await c.call('chat.sessions.delete', { sessionId: a.id, confirm: true });
    expect(del.error).toBeUndefined();
    expect(c.notifications.some(n => n.method === 'permission.resolved' && n.params.requestId === ra && n.params.reason === 'session-deleted')).toBe(true);
    await new Promise(r => setTimeout(r, 200));
    expect(c.notifications.some(n => n.method === 'permission.resolved' && n.params.requestId === rb), 'B 的卡被连带了结了').toBe(false);

    // B 的 run 没被 abort：批准后真的写入，结果是成功而不是 [已取消]
    await c.call('permission.respond', { requestId: rb, decision: 'allow-once' });
    await waitFor('B 的技能文件写入', () => existsSync(join(dataDir, 'skills', 'b', 'SKILL.md')));
    await waitFor('B 的 toolResult 落库', () => toolResults(dataDir, b.id).length > 0);
    expect(toolResults(dataDir, b.id)[0]).toMatchObject({ success: true });
    expect(existsSync(join(dataDir, 'skills', 'a', 'SKILL.md'))).toBe(false);
  }, 30000);
});

describe('W1b-5 standalone 收到 shutdown：close 做完才退出（closeThenExit）', () => {
  const tick = () => new Promise(r => setTimeout(r, 0));

  it('close({ graceMs: CLOSE_GRACE_MS }) 没完成之前不退出；完成后 exit(0) 恰好一次', async () => {
    let finish!: () => void;
    const closeArgs: unknown[] = [];
    const inst = { close: (o?: { graceMs?: number }) => { closeArgs.push(o); return new Promise<void>(r => { finish = r; }); } };
    const exits: number[] = [];
    const done = closeThenExit(Promise.resolve(inst), code => { exits.push(code); });
    await tick();
    expect(closeArgs).toEqual([{ graceMs: CLOSE_GRACE_MS }]);
    expect(exits, '库还没关完就退出了').toEqual([]);
    finish();
    await done;
    expect(exits).toEqual([0]);
  });

  it('close 失败也照样 exit(0)（关停尽力而为，不能让进程挂着）', async () => {
    const exits: number[] = [];
    await closeThenExit(Promise.resolve({ close: () => Promise.reject(new Error('关停出错')) }), code => { exits.push(code); });
    expect(exits).toEqual([0]);
  });

  it('启动失败：不 close、不 exit(0)——退出交给 reportStartupFailure（它先写致命行再退 1）', async () => {
    const exits: number[] = [];
    await closeThenExit(Promise.reject(new Error('DATA_ROOT_LOCKED')), code => { exits.push(code); });
    await tick();
    expect(exits).toEqual([]);
  });
});
