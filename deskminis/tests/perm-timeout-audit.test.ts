/** W2b-7（设计稿 §4.1 的 W2b-7 行，来由是 W1b-5 修正者申报）：权限询问超时了结时，审计写入失败不能变成未捕获异常。
 *
 *  超时那段在 minisd 的 setTimeout 回调里：广播 permission.resolved(timeout) → 写审计 → resolve('deny')。
 *  库写失败（SQLITE_FULL / SQLITE_BUSY）时 audit.append 抛出，以前这一抛发生在定时器里，就是一次未捕获异常——
 *  standalone 下引擎当场退出（W2b-7 之后是记一条崩溃再退出），界面上所有会话一起断线；resolve 也被跳过。
 *  现在审计写入兜住：失败只记一笔警告（console.warn → stderr → 主进程落进按天日志），卡片照常按超时了结、run 照常收到拒绝。
 *
 *  故障用旁路连接的触发器注入（同 tests/shutdown-partial-reply.test.ts 的 (f)）：只让 permission.resolved 的插入失败。
 *  权限卡用 file_write 写 /var/minis/skills/x/SKILL.md 触发（W1b-2 之后技能目录走卡）；
 *  不用 POSIX 绝对路径——paths.ts 在 Linux 上对它直接抛错，走不到网关（设计稿 §1 第 7 条）。
 *  另钉一条：进程内起的 minisd 不在 process 上挂崩溃监听（钩子只装在 standalone 分支，装进测试 worker 会吞掉测试框架自己的异常）。 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import WebSocket from 'ws';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMinisd } from '../src/minisd/index';

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
  ws.on('error', () => { /* 关停时连接被断，属预期 */ });
  const ready = new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
  function call(method: string, params?: unknown): Promise<any> {
    const id = ++idc;
    return new Promise((res) => { pending.set(id, res); ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); });
  }
  return { ready, call, notifications, close: () => ws.close() };
}

async function waitFor(what: string, cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise(r => setTimeout(r, 10));
  }
}

const toolScript = (name: string, input: Record<string, unknown>): string => `__tool__ ${name} ${JSON.stringify(input)}`;

/** 会话里落了库的 toolResult（直接读库） */
function toolResults(dataDir: string, sessionId: string): any[] {
  const db = new Database(join(dataDir, 'minis.db'), { readonly: true });
  try {
    const rows = db.prepare('SELECT parts_json FROM messages WHERE session_id = ? ORDER BY sort_order').all(sessionId) as { parts_json: string }[];
    return rows.flatMap(r => JSON.parse(r.parts_json)).filter((p: any) => p.type === 'toolResult').map((p: any) => p.value);
  } finally { db.close(); }
}

describe('权限询问超时了结：审计写入失败时', () => {
  it('卡片照常按超时了结、run 收到拒绝；定时器里不抛未捕获异常，只记一笔警告', async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown): void => { uncaught.push(e); };
    process.on('uncaughtException', onUncaught);
    const warns: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.map(String).join(' ')); });
    cleanups.push(() => { process.off('uncaughtException', onUncaught); warn.mockRestore(); });

    const listeners = () => [process.listenerCount('uncaughtException'), process.listenerCount('unhandledRejection')];
    const before = listeners();
    const dataDir = mkdtempSync(join(tmpdir(), 'dm-perm-timeout-audit-'));
    process.env.DESKMINIS_TEST = '1';
    process.env.DESKMINIS_FAKE_PROVIDER = '1';
    const srv = await startMinisd({ dataDir, host: '127.0.0.1', port: 0, permTimeoutMs: 400 });
    cleanups.push(() => srv.close());
    expect(listeners(), '进程内起的 minisd 不装崩溃钩子').toEqual(before);
    const c = rpcClient(srv.port, srv.authToken);
    await c.ready;
    cleanups.push(() => c.close());

    // 旁路连接注入故障：此后「权限卡了结」的审计写入一律失败（SQLITE_FULL / SQLITE_BUSY 的替身）
    const side = new Database(join(dataDir, 'minis.db'));
    side.exec(`CREATE TRIGGER inject_audit_fail BEFORE INSERT ON audit_logs WHEN NEW.event_type = 'permission.resolved'
               BEGIN SELECT RAISE(ABORT, '注入：审计写入失败'); END`);
    side.close();

    const s = (await c.call('chat.sessions.create', {})).result;
    await c.call('chat.prompt', { sessionId: s.id, providerId: '__fake__', text: toolScript('file_write', { path: '/var/minis/skills/x/SKILL.md', content: 'x', tool_title: '写技能' }) });
    await waitFor('permission.request', () => c.notifications.some(n => n.method === 'permission.request'));
    const requestId = c.notifications.find(n => n.method === 'permission.request')!.params.requestId as string;

    await waitFor('permission.resolved(timeout)', () => c.notifications.some(n => n.method === 'permission.resolved' && n.params.requestId === requestId && n.params.reason === 'timeout'));
    await waitFor('toolResult 落库', () => toolResults(dataDir, s.id).length > 0);
    await new Promise(r => setTimeout(r, 100));

    expect(uncaught, '审计写入失败从定时器里抛成了未捕获异常').toEqual([]);
    expect(toolResults(dataDir, s.id)[0]).toMatchObject({ success: false });
    expect(existsSync(join(dataDir, 'skills', 'x', 'SKILL.md')), '没批准就没写').toBe(false);
    expect(warns.some(w => w.includes(requestId) && w.includes('审计')), '失败要留一笔（stderr → 主进程的按天日志）').toBe(true);
  }, 30000);
});
