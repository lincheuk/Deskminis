/**
 * F04 minisd 级：生产链路（index.ts 装配 → chat.prompt → 循环 → 工具 → 落库）上的跨会话资源锁、取消与关停。
 *
 * 走真实 minisd（进程内起、RPC 驱动），调度器是 index.ts 为本引擎实例建的那一个；本文件对 F04 的新模块没有运行时引入。
 * FakeProvider 每次提问只发一个工具调用（index.ts），所以「同批」的用例放在循环级（tool-scheduler-loop），这里只测跨会话与生命周期。
 *
 * 权限卡用 file_write /var/minis/skills/... 触发：技能目录的写要问（data-gate.ts），放行前不落盘，任何平台都可用。
 * 「此刻不该有第二张卡」这类反面断言前会等一小段时间：正确的实现下结果与等多久无关，等待只是给错误的实现留出露馅的时间。
 */
import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMinisd, type StartMinisdOpts } from '../src/minisd/index';

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
type Client = ReturnType<typeof rpcClient>;

/** 起一个进程内 minisd。dataDir 可指定（关停后在同一数据根上重开）。 */
async function boot(opts: StartMinisdOpts = {}) {
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), 'dm-f04-m-'));
  process.env.DESKMINIS_TEST = '1';
  process.env.DESKMINIS_FAKE_PROVIDER = '1';
  const srv = await startMinisd({ host: '127.0.0.1', port: 0, permTimeoutMs: 60000, ...opts, dataDir });
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

const cards = (c: Client, sessionId?: string) =>
  c.notifications.filter(n => n.method === 'permission.request' && (sessionId === undefined || n.params.req.sessionId === sessionId));
const resolvedOf = (c: Client, requestId: string) =>
  c.notifications.filter(n => n.method === 'permission.resolved' && n.params.requestId === requestId);
const eventsOf = (c: Client, sessionId: string) =>
  c.notifications.filter(n => n.method === 'chat.event' && n.params.sessionId === sessionId).map(n => n.params.event);
const turnEnded = (c: Client, sessionId: string, atLeast = 1) =>
  eventsOf(c, sessionId).filter(e => e.kind === 'turnEnd').length >= atLeast;

async function promptWrite(c: Client, sessionId: string, guest: string, content: string, title: string): Promise<void> {
  const r = await c.call('chat.prompt', { sessionId, providerId: '__fake__', text: toolScript('file_write', { path: guest, content, tool_title: title }) });
  expect(r.error).toBeUndefined();
}

describe('F04 跨会话写同一文件（生产链路）', () => {
  it('M1 A 的权限卡挂着时 B 写同一文件：B 等 A 写完才问权限，卡上的旧内容是 A 写入的结果', async () => {
    const { c, dataDir } = await boot();
    const a = (await c.call('chat.sessions.create', {})).result;
    const b = (await c.call('chat.sessions.create', {})).result;
    const guest = '/var/minis/skills/f04/note.txt';
    const abs = join(dataDir, 'skills', 'f04', 'note.txt');

    await promptWrite(c, a.id, guest, 'A 的内容', 'A 写');
    await waitFor('A 的权限卡', () => cards(c, a.id).length === 1);
    await promptWrite(c, b.id, guest, 'B 的内容', 'B 写');
    await waitFor('B 的 toolStart', () => eventsOf(c, b.id).some(e => e.kind === 'toolStart'));
    await sleep(300);
    // B 在等 A 手里的锁：还没进工具，不该有第二张卡
    expect(cards(c)).toHaveLength(1);
    expect(existsSync(abs)).toBe(false);

    await c.call('permission.respond', { requestId: cards(c, a.id)[0].params.requestId, decision: 'allow-once' });
    await waitFor('B 的权限卡', () => cards(c, b.id).length === 1);
    expect(cards(c, b.id)[0].params.req.preview.oldText).toBe('A 的内容');
    await c.call('permission.respond', { requestId: cards(c, b.id)[0].params.requestId, decision: 'allow-once' });
    await waitFor('A、B 都跑完', () => turnEnded(c, a.id) && turnEnded(c, b.id));

    expect(readFileSync(abs, 'utf8')).toBe('B 的内容');
    expect(eventsOf(c, a.id).filter(e => e.kind === 'toolEnd').map(e => e.success)).toEqual([true]);
    expect(eventsOf(c, b.id).filter(e => e.kind === 'toolEnd').map(e => e.success)).toEqual([true]);
  }, 30000);
});

describe('F04 等审批时取消（生产链路）', () => {
  it('M3 权限卡挂着时 chat.cancel：卡片按 cancelled 了结、回合立即收尾、锁放开；旧卡再批准不执行，重发只有一张新卡', async () => {
    const { c, dataDir } = await boot();
    const s = (await c.call('chat.sessions.create', {})).result;
    const guest = '/var/minis/skills/f04/c.txt';
    const abs = join(dataDir, 'skills', 'f04', 'c.txt');

    await promptWrite(c, s.id, guest, '第一次', '写 c');
    await waitFor('权限卡', () => cards(c, s.id).length === 1);
    const oldId = cards(c, s.id)[0].params.requestId;

    // ① 取消：这张卡 1 秒内按 cancelled 了结
    expect((await c.call('chat.cancel', { sessionId: s.id })).error).toBeUndefined();
    await waitFor('旧卡按 cancelled 了结', () => resolvedOf(c, oldId).some(n => n.params.reason === 'cancelled'), 1000);
    // ② 回合 3 秒内收尾：落库的是 [已取消]，文件没写
    await waitFor('回合报已取消', () => eventsOf(c, s.id).some(e => e.kind === 'error' && e.message === '已取消'), 3000);
    const msgs = (await c.call('chat.messages.list', { sessionId: s.id })).result as { parts: { type: string; value: any }[] }[];
    const results = msgs.flatMap(m => m.parts).filter(p => p.type === 'toolResult');
    expect(results.map(p => p.value.output)).toEqual(['[已取消]']);
    expect(existsSync(abs)).toBe(false);

    // ③ 对旧卡再点「允许」：条目已不在，什么都不发生
    expect((await c.call('permission.respond', { requestId: oldId, decision: 'allow-once' })).error).toBeUndefined();
    await sleep(300);
    expect(existsSync(abs)).toBe(false);
    expect(resolvedOf(c, oldId).map(n => n.params.reason)).toEqual(['cancelled']);

    // ④ 同一会话重发同一写入：只多出一张卡（新的 requestId），批准后落盘
    await promptWrite(c, s.id, guest, '第一次', '写 c');
    await waitFor('重发后的权限卡', () => cards(c, s.id).length === 2);
    const newId = cards(c, s.id)[1].params.requestId;
    expect(newId).not.toBe(oldId);
    await c.call('permission.respond', { requestId: newId, decision: 'allow-once' });
    await waitFor('重发的回合跑完', () => turnEnded(c, s.id));
    expect(readFileSync(abs, 'utf8')).toBe('第一次');
    expect(cards(c, s.id)).toHaveLength(2);

    // ⑤ 另一个会话写同一路径：锁已放开，卡立即出现，批准后落盘
    const other = (await c.call('chat.sessions.create', {})).result;
    await promptWrite(c, other.id, guest, '别的会话', '另写 c');
    await waitFor('另一会话的权限卡', () => cards(c, other.id).length === 1);
    await c.call('permission.respond', { requestId: cards(c, other.id)[0].params.requestId, decision: 'allow-once' });
    await waitFor('另一会话跑完', () => turnEnded(c, other.id));
    expect(readFileSync(abs, 'utf8')).toBe('别的会话');
  }, 30000);

  it('M3b 取消后旧卡不会再按超时了结：只有一条 cancelled，没有 timeout；随后删除会话不再了结任何卡', async () => {
    const { c, dataDir } = await boot({ permTimeoutMs: 800 });
    const s = (await c.call('chat.sessions.create', {})).result;
    const guest = '/var/minis/skills/f04/c2.txt';

    await promptWrite(c, s.id, guest, '不该落盘', '写 c2');
    await waitFor('权限卡', () => cards(c, s.id).length === 1);
    const requestId = cards(c, s.id)[0].params.requestId;
    expect((await c.call('chat.cancel', { sessionId: s.id })).error).toBeUndefined();
    await waitFor('回合报已取消', () => eventsOf(c, s.id).some(e => e.kind === 'error' && e.message === '已取消'), 3000);

    // 等过权限兜底时限（800ms）：卡已在取消时了结，到点不该再冒出一条 timeout
    await sleep(1500);
    expect(resolvedOf(c, requestId).map(n => n.params.reason)).toEqual(['cancelled']);
    expect(c.notifications.filter(n => n.method === 'permission.resolved' && n.params.reason === 'timeout')).toEqual([]);

    const resolvedBefore = c.notifications.filter(n => n.method === 'permission.resolved').length;
    const del = await c.call('chat.sessions.delete', { sessionId: s.id, confirm: true });
    expect(del.error).toBeUndefined();
    await sleep(200);
    expect(c.notifications.filter(n => n.method === 'permission.resolved')).toHaveLength(resolvedBefore);
    expect(existsSync(join(dataDir, 'skills', 'f04', 'c2.txt'))).toBe(false);
  }, 30000);
});

describe('F04 等锁中的会话被删除、关停后重开、等锁超时（生产链路）', () => {
  it('M2 删除正在等别的会话放锁的会话：删除及时成功，持锁方的卡原样待批，批准后落盘的是它的内容', async () => {
    // runStopTimeoutMs 收短：等锁不认取消的话，删除等不到 run 收尾，3 秒后报「仍在停止中」
    const { c, dataDir } = await boot({ runStopTimeoutMs: 3000 });
    const a = (await c.call('chat.sessions.create', {})).result;
    const b = (await c.call('chat.sessions.create', {})).result;
    const guest = '/var/minis/skills/f04/m2.txt';
    const abs = join(dataDir, 'skills', 'f04', 'm2.txt');

    await promptWrite(c, a.id, guest, 'A 的内容', 'A 写');
    await waitFor('A 的权限卡', () => cards(c, a.id).length === 1);
    const aCard = cards(c, a.id)[0].params.requestId;
    await promptWrite(c, b.id, guest, 'B 的内容', 'B 写');
    await waitFor('B 的 toolStart', () => eventsOf(c, b.id).some(e => e.kind === 'toolStart'));

    const del = await c.call('chat.sessions.delete', { sessionId: b.id, confirm: true });
    expect(del.error).toBeUndefined();
    expect(del.result).toEqual({ ok: true });
    const left = (await c.call('chat.sessions.list', {})).result as { id: string }[];
    expect(left.map(s => s.id)).not.toContain(b.id);
    // B 从没进过工具：没有它的卡；A 的卡没被动过
    expect(cards(c, b.id)).toHaveLength(0);
    expect(resolvedOf(c, aCard)).toHaveLength(0);
    expect(existsSync(abs)).toBe(false);

    await c.call('permission.respond', { requestId: aCard, decision: 'allow-once' });
    await waitFor('A 跑完', () => turnEnded(c, a.id));
    expect(readFileSync(abs, 'utf8')).toBe('A 的内容');
    await sleep(200);
    expect(cards(c, b.id)).toHaveLength(0);
    expect(readFileSync(abs, 'utf8')).toBe('A 的内容');
  }, 30000);

  it('M4 权限卡挂着时关停，再在同一数据根上重开：同一会话、同一路径的写入批准后成功（锁只在内存里，没有残留）', async () => {
    const first = await boot();
    const s = (await first.c.call('chat.sessions.create', {})).result;
    const guest = '/var/minis/skills/f04/m4.txt';
    const abs = join(first.dataDir, 'skills', 'f04', 'm4.txt');
    await promptWrite(first.c, s.id, guest, '同一会话的内容', '写 m4');
    await waitFor('关停前的权限卡', () => cards(first.c, s.id).length === 1);
    await first.close();
    expect(existsSync(abs)).toBe(false);

    const second = await boot({ dataDir: first.dataDir });
    // 同一会话重发。FakeProvider 只认会话里第一条脚本（index.ts 的 parseScript），所以两次的内容写成一样的
    await promptWrite(second.c, s.id, guest, '同一会话的内容', '再写 m4');
    await waitFor('重开后的权限卡', () => cards(second.c, s.id).length === 1);
    await second.c.call('permission.respond', { requestId: cards(second.c, s.id)[0].params.requestId, decision: 'allow-once' });
    await waitFor('重开后的回合跑完', () => turnEnded(second.c, s.id));
    expect(readFileSync(abs, 'utf8')).toBe('同一会话的内容');
    expect(eventsOf(second.c, s.id).filter(e => e.kind === 'toolEnd').map(e => e.success)).toEqual([true]);

    // 另一个会话写同一路径：卡立即出现，批准后落盘
    const other = (await second.c.call('chat.sessions.create', {})).result;
    await promptWrite(second.c, other.id, guest, '重开后别的会话', '另写 m4');
    await waitFor('另一会话的权限卡', () => cards(second.c, other.id).length === 1);
    expect(cards(second.c, other.id)[0].params.req.preview.oldText).toBe('同一会话的内容');
    await second.c.call('permission.respond', { requestId: cards(second.c, other.id)[0].params.requestId, decision: 'allow-once' });
    await waitFor('另一会话跑完', () => turnEnded(second.c, other.id));
    expect(readFileSync(abs, 'utf8')).toBe('重开后别的会话');
  }, 30000);

  it('M5 等别的会话超过上限：不弹卡、不执行，工具结果说明是等待资源超时，回合正常结束，落库配对', async () => {
    const { c, dataDir } = await boot({ toolLockWaitTimeoutMs: 200 });
    const a = (await c.call('chat.sessions.create', {})).result;
    const b = (await c.call('chat.sessions.create', {})).result;
    const guest = '/var/minis/skills/f04/t.txt';
    const abs = join(dataDir, 'skills', 'f04', 't.txt');

    await promptWrite(c, a.id, guest, 'A 的内容', 'A 写');
    await waitFor('A 的权限卡', () => cards(c, a.id).length === 1);
    const aCard = cards(c, a.id)[0].params.requestId;
    await promptWrite(c, b.id, guest, 'B 的内容', 'B 写');
    await waitFor('B 的回合收尾', () => turnEnded(c, b.id) || eventsOf(c, b.id).some(e => e.kind === 'error'), 10000);

    const evB = eventsOf(c, b.id);
    expect(evB.filter(e => e.kind === 'error')).toEqual([]);
    const ends = evB.filter(e => e.kind === 'toolEnd');
    expect(ends).toHaveLength(1);
    expect(ends[0].success).toBe(false);
    expect(ends[0].output).toContain('等待资源超时');
    expect(cards(c, b.id)).toHaveLength(0);
    expect(existsSync(abs)).toBe(false);

    const msgs = (await c.call('chat.messages.list', { sessionId: b.id })).result as { parts: { type: string; value: any }[] }[];
    const parts = msgs.flatMap(m => m.parts);
    const uses = parts.filter(p => p.type === 'toolUse');
    const results = parts.filter(p => p.type === 'toolResult');
    expect(uses).toHaveLength(1);
    expect(results).toHaveLength(1);
    expect(results[0].value).toMatchObject({ toolUseId: uses[0].value.toolUseId, success: false, status: 'failed' });
    expect(results[0].value.output).toContain('等待资源超时');

    // 持锁方不受影响：A 的卡还在，批准后落盘的是 A 的内容
    expect(resolvedOf(c, aCard)).toHaveLength(0);
    await c.call('permission.respond', { requestId: aCard, decision: 'allow-once' });
    await waitFor('A 跑完', () => turnEnded(c, a.id));
    expect(readFileSync(abs, 'utf8')).toBe('A 的内容');
  }, 30000);
});

describe('F04 等锁期间会话工作区被改（生产链路）', () => {
  it('M6 等别的会话放锁时用 workspace.set 改了运行中会话的工作区：这次写不执行、不弹卡，新工作区里另一会话挂着的卡不受影响', async () => {
    const { c, dataDir } = await boot();
    const h = (await c.call('chat.sessions.create', {})).result;
    const a = (await c.call('chat.sessions.create', {})).result;
    const b = (await c.call('chat.sessions.create', {})).result;
    // 工作区绑在技能目录下：相对路径的写入要问（data-gate.ts），权限卡就是受控延迟
    const W1 = join(dataDir, 'skills', 'f04-m6-w1'); const W2 = join(dataDir, 'skills', 'f04-m6-w2');
    mkdirSync(W1, { recursive: true }); mkdirSync(W2, { recursive: true });
    for (const [s, root] of [[h, W1], [a, W1], [b, W2]] as const) {
      expect((await c.call('workspace.set', { sessionId: s.id, root })).error).toBeUndefined();
    }

    // H 与 B 各自的卡挂着：H 持有 W1/x.txt 的写锁，B 持有 W2/x.txt 的写锁
    await promptWrite(c, h.id, 'x.txt', 'H 的内容', 'H 写');
    await waitFor('H 的权限卡', () => cards(c, h.id).length === 1);
    await promptWrite(c, b.id, 'x.txt', 'B 的内容', 'B 写');
    await waitFor('B 的权限卡', () => cards(c, b.id).length === 1);
    const bCard = cards(c, b.id)[0].params;
    expect(bCard.req.preview.oldText).toBe('');
    // A 的相对路径此刻指向 W1/x.txt：在等 H 手里的锁，还没进工具
    await promptWrite(c, a.id, 'x.txt', 'A 的内容', 'A 写');
    await waitFor('A 的 toolStart', () => eventsOf(c, a.id).some(e => e.kind === 'toolStart'));
    await sleep(300);
    expect(cards(c, a.id)).toHaveLength(0);

    // 回合进行中改工作区：workspace.set 不看会话是否在跑，A 的相对路径从此指向 W2/x.txt
    expect((await c.call('workspace.set', { sessionId: a.id, root: W2 })).error).toBeUndefined();

    await c.call('permission.respond', { requestId: cards(c, h.id)[0].params.requestId, decision: 'allow-once' });
    await waitFor('H 跑完', () => turnEnded(c, h.id));
    // A 拿到的是 W1/x.txt 的锁：不能拿着它去写 W2/x.txt。弹了卡就说明它拿着旧锁进了工具——同一个文件两张卡并存
    await waitFor('A 的调用落定或弹卡', () => cards(c, a.id).length > 0 || eventsOf(c, a.id).some(e => e.kind === 'toolEnd'));
    expect(cards(c, a.id)).toHaveLength(0);
    await waitFor('A 的回合收尾', () => turnEnded(c, a.id) || eventsOf(c, a.id).some(e => e.kind === 'error'));

    const evA = eventsOf(c, a.id);
    expect(evA.filter(e => e.kind === 'error')).toEqual([]);
    const ends = evA.filter(e => e.kind === 'toolEnd');
    expect(ends).toHaveLength(1);
    expect(ends[0].success).toBe(false);
    expect(ends[0].output).toContain('调度条件在等待执行期间已变');
    expect(ends[0].output).toContain('没有执行');
    const msgs = (await c.call('chat.messages.list', { sessionId: a.id })).result as { parts: { type: string; value: any }[] }[];
    const parts = msgs.flatMap(m => m.parts);
    const uses = parts.filter(p => p.type === 'toolUse');
    const results = parts.filter(p => p.type === 'toolResult');
    expect(uses).toHaveLength(1);
    expect(results).toHaveLength(1);
    expect(results[0].value).toMatchObject({ toolUseId: uses[0].value.toolUseId, success: false, status: 'failed' });

    // H 写的是 W1；W2/x.txt 仍不存在，B 的卡没被动过——卡上「新建文件」的差分没有过期
    expect(readFileSync(join(W1, 'x.txt'), 'utf8')).toBe('H 的内容');
    expect(existsSync(join(W2, 'x.txt'))).toBe(false);
    expect(resolvedOf(c, bCard.requestId)).toHaveLength(0);
    await c.call('permission.respond', { requestId: bCard.requestId, decision: 'allow-once' });
    await waitFor('B 跑完', () => turnEnded(c, b.id));
    expect(readFileSync(join(W2, 'x.txt'), 'utf8')).toBe('B 的内容');
    expect(cards(c, a.id)).toHaveLength(0);
  }, 30000);
});
