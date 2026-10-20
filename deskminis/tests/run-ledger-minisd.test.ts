/**
 * F05 M 组：生产链路（index.ts 装配 → chat.prompt → 循环 → 调度器 → 账本 → 落库）上的运行状态与幂等。
 *
 * 走真实 minisd（进程内起、RPC 驱动）。本文件不引任何 F05 的新模块：只经 RPC、直接读库、读文件系统断言，
 * 所以在 F05 之前的基线上也跑得起来、红在行为上（M1、M2 是先红证据）。
 *
 * 权限卡用 file_write /var/minis/skills/... 触发：技能目录的写要问（data-gate.ts），放行前不落盘，任何平台都可用。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMinisd, type StartMinisdOpts } from '../src/minisd/index';
import { MIGRATIONS, runMigrations } from '../src/minisd/store/db';
import { ChatStore } from '../src/minisd/store/chat-store';
import { serializeParts } from '../src/shared/parts';
import { McpHttpClient } from '../src/minisd/mcp/http';
import type { ContentPart } from '../src/shared/types';
import { cardsOf, eventsOf, readDb, rpcClient, sleep, waitFor, type Client } from './run-ledger-fixture';
import { stripComments } from './strip-comments';
import { watchEngine, watchLaunch } from './engine-wiring';
import { callMark, onCall, sequence, yieldProbe } from './engine-trace';
import { expectSame } from './engine-trace';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) { try { await f(); } catch { /* 收尾尽力 */ } }
});

/** 起一个进程内 minisd。dataDir 可指定（关停后在同一数据根上重开）；seed 在起之前往数据根里铺文件。 */
async function boot(opts: StartMinisdOpts = {}, seed?: (dir: string) => void) {
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), 'dm-f05-m-'));
  process.env.DESKMINIS_TEST = '1';
  process.env.DESKMINIS_FAKE_PROVIDER = '1';
  seed?.(dataDir);
  const srv = await startMinisd({ host: '127.0.0.1', port: 0, permTimeoutMs: 60000, ...opts, dataDir });
  cleanups.push(() => srv.close());
  const c = rpcClient(srv.port, srv.authToken);
  await c.ready;
  cleanups.push(() => c.close());
  return { ...srv, dataDir, c };
}

function toolScript(name: string, input: Record<string, unknown>): string {
  return `__tool__ ${name} ${JSON.stringify(input)}`;
}
const turnEnded = (c: Client, sessionId: string, atLeast = 1): boolean =>
  eventsOf(c, sessionId).filter(e => e.kind === 'turnEnd').length >= atLeast;
type Msg = { id: string; role: string; parts: { type: string; value: any }[] };
async function messagesOf(c: Client, sessionId: string): Promise<Msg[]> {
  return (await c.call('chat.messages.list', { sessionId })).result as Msg[];
}
const userPrompts = (msgs: Msg[]): Msg[] => msgs.filter(m => m.role === 'user' && m.parts.some(p => p.type === 'text'));

describe('F05 同一 promptId 重复提交（生产链路）', () => {
  it('M1 run 挂在权限卡上时再提交同一 promptId：答 duplicate 与原 run，不报「运行中」、不落第二条消息、不弹第二张卡', async () => {
    const { c } = await boot();
    const s = (await c.call('chat.sessions.create', {})).result;
    const promptId = 'f05-m1-0001';
    const text = toolScript('file_write', { path: '/var/minis/skills/f05/m1.txt', content: 'x', tool_title: '写 m1' });

    const r1 = await c.call('chat.prompt', { sessionId: s.id, providerId: '__fake__', text, promptId });
    expect(r1.error).toBeUndefined();
    await waitFor('权限卡', () => cardsOf(c, s.id).length === 1);

    const r2 = await c.call('chat.prompt', { sessionId: s.id, providerId: '__fake__', text, promptId });
    expect(r2.error).toBeUndefined();
    expect(r2.result).toMatchObject({ ok: true, duplicate: true, state: 'running' });
    expect(r1.result).toMatchObject({ ok: true, duplicate: false, state: 'running' });
    expect(typeof r1.result.runId).toBe('string');
    expect(r2.result.runId).toBe(r1.result.runId);
    expect(r2.result.generation).toBe(1);

    await sleep(200);
    expect(userPrompts(await messagesOf(c, s.id))).toHaveLength(1);
    expect(cardsOf(c, s.id)).toHaveLength(1);
  }, 30000);

  it('M2 run 完成后再提交同一 promptId：答 duplicate 与 completed，消息数不变，没有新的 chat.event', async () => {
    const { c } = await boot();
    const s = (await c.call('chat.sessions.create', {})).result;
    const promptId = 'f05-m2-0001';

    const r1 = await c.call('chat.prompt', { sessionId: s.id, providerId: '__fake__', text: '你好', promptId });
    expect(r1.error).toBeUndefined();
    await waitFor('第一次运行结束', () => turnEnded(c, s.id));
    // 不用再等：run 的终态在 turnEnd 广播之前就已提交，幂等检查又排在「运行中」守卫之前
    const before = (await messagesOf(c, s.id)).length;
    const eventsBefore = eventsOf(c, s.id).length;

    const r2 = await c.call('chat.prompt', { sessionId: s.id, providerId: '__fake__', text: '你好', promptId });
    expect(r2.error).toBeUndefined();
    expect(r2.result).toMatchObject({ ok: true, duplicate: true, state: 'completed' });
    expect(r2.result.runId).toBe(r1.result.runId);

    await sleep(300);
    expect((await messagesOf(c, s.id)).length).toBe(before);
    expect(eventsOf(c, s.id).length).toBe(eventsBefore);
  }, 30000);
});

// ---------- 以下是 M3–M14（实现之后追加；M1、M2 的文本不动） ----------

const SKILL_WRITE = (name: string): string => toolScript('file_write', { path: `/var/minis/skills/f05/${name}`, content: 'x', tool_title: `写 ${name}` });
const seedFakeDefault = (dir: string): void => {
  writeFileSync(join(dir, 'providers.json'), JSON.stringify({ providers: [], defaultProviderId: '__fake__' }), 'utf8');
};
const runsOf = (dataDir: string, sessionId: string): any[] => readDb(dataDir, 'SELECT * FROM agent_runs WHERE session_id=? ORDER BY generation', sessionId);
const execsOf = (dataDir: string, sessionId: string): any[] => readDb(dataDir, 'SELECT * FROM tool_executions WHERE session_id=? ORDER BY batch, call_index', sessionId);
const activeRuns = (dataDir: string): number => (readDb(dataDir, 'SELECT COUNT(*) n FROM agent_runs WHERE active=1')[0] as { n: number }).n;
async function second(srv: { port: number; authToken: string }): Promise<Client> {
  const c = rpcClient(srv.port, srv.authToken);
  await c.ready;
  cleanups.push(() => c.close());
  return c;
}

describe('F05 并发提交（生产链路）', () => {
  it('M3 两条连接同时提交同一 promptId：两个应答都成功，恰好一个 duplicate；一个 run、一条 user 消息', async () => {
    const m = await boot();
    const c2 = await second(m);
    const s = (await m.c.call('chat.sessions.create', {})).result;
    const p = { sessionId: s.id, providerId: '__fake__', text: SKILL_WRITE('m3.txt'), promptId: 'f05-m3-0001' };
    const [r1, r2] = await Promise.all([m.c.call('chat.prompt', p), c2.call('chat.prompt', p)]);
    expect(r1.error).toBeUndefined();
    expect(r2.error).toBeUndefined();
    expect([r1.result.duplicate, r2.result.duplicate].sort()).toEqual([false, true]);
    expect(r1.result.runId).toBe(r2.result.runId);
    await waitFor('权限卡', () => cardsOf(m.c, s.id).length === 1);
    await sleep(200);
    expect(runsOf(m.dataDir, s.id)).toHaveLength(1);
    expect(userPrompts(await messagesOf(m.c, s.id))).toHaveLength(1);
    expect(cardsOf(m.c, s.id)).toHaveLength(1);
  }, 30000);

  it('M3b 同一条连接上紧挨着发两次同一 promptId（两帧同一拍到达）：同样恰好一个 duplicate、一个 run、一条 user 消息', async () => {
    const m = await boot();
    const s = (await m.c.call('chat.sessions.create', {})).result;
    const p = { sessionId: s.id, providerId: '__fake__', text: SKILL_WRITE('m3b.txt'), promptId: 'f05-m3b-0001' };
    const [r1, r2] = await Promise.all([m.c.call('chat.prompt', p), m.c.call('chat.prompt', p)]);
    expect(r1.error).toBeUndefined();
    expect(r2.error).toBeUndefined();
    expect([r1.result.duplicate, r2.result.duplicate].sort()).toEqual([false, true]);
    expect(r1.result.runId).toBe(r2.result.runId);
    await waitFor('权限卡', () => cardsOf(m.c, s.id).length === 1);
    await sleep(200);
    expect(runsOf(m.dataDir, s.id)).toHaveLength(1);
    expect(userPrompts(await messagesOf(m.c, s.id))).toHaveLength(1);
  }, 30000);

  it('M4 两条连接同时提交不同的消息：一个成功、一个「该会话正在运行中」；活动 run 恒不超过一个；不带 promptId 的应答全等 { ok: true }', async () => {
    const m = await boot();
    const c2 = await second(m);
    // (i) 不同的 promptId
    const a = (await m.c.call('chat.sessions.create', {})).result;
    const [x1, x2] = await Promise.all([
      m.c.call('chat.prompt', { sessionId: a.id, providerId: '__fake__', text: SKILL_WRITE('m4-a.txt'), promptId: 'f05-m4-a' }),
      c2.call('chat.prompt', { sessionId: a.id, providerId: '__fake__', text: SKILL_WRITE('m4-b.txt'), promptId: 'f05-m4-b' }),
    ]);
    const ok = [x1, x2].filter(r => !r.error); const bad = [x1, x2].filter(r => r.error);
    expect(ok).toHaveLength(1);
    expect(ok[0].result).toMatchObject({ ok: true, duplicate: false, generation: 1 });
    expect(bad[0].error.message).toContain('该会话正在运行中');
    expect(runsOf(m.dataDir, a.id)).toHaveLength(1);
    expect(activeRuns(m.dataDir)).toBe(1);

    // (ii) 都不带 promptId
    const b = (await m.c.call('chat.sessions.create', {})).result;
    const [y1, y2] = await Promise.all([
      m.c.call('chat.prompt', { sessionId: b.id, providerId: '__fake__', text: SKILL_WRITE('m4-c.txt') }),
      c2.call('chat.prompt', { sessionId: b.id, providerId: '__fake__', text: SKILL_WRITE('m4-d.txt') }),
    ]);
    const ok2 = [y1, y2].filter(r => !r.error); const bad2 = [y1, y2].filter(r => r.error);
    expect(ok2).toHaveLength(1);
    expect(ok2[0].result).toEqual({ ok: true });
    expect(bad2[0].error.message).toContain('该会话正在运行中');
    expect(runsOf(m.dataDir, b.id)).toHaveLength(1);
    expect(activeRuns(m.dataDir)).toBe(2);
  }, 30000);

  it('M4c 同一 promptId、不同的内容：报错，不落消息、不起 run；非法 promptId 报错', async () => {
    const { c, dataDir } = await boot();
    const s = (await c.call('chat.sessions.create', {})).result;
    const r1 = await c.call('chat.prompt', { sessionId: s.id, providerId: '__fake__', text: '第一条', promptId: 'f05-m4c' });
    expect(r1.error).toBeUndefined();
    await waitFor('第一条跑完', () => turnEnded(c, s.id));
    const before = (await messagesOf(c, s.id)).length;
    const r2 = await c.call('chat.prompt', { sessionId: s.id, providerId: '__fake__', text: '另一条', promptId: 'f05-m4c' });
    expect(r2.error.message).toContain('promptId 已用于另一条消息');
    for (const bad of ['', 'a b', 'x'.repeat(129), 42]) {
      expect((await c.call('chat.prompt', { sessionId: s.id, providerId: '__fake__', text: '你好', promptId: bad })).error.message, String(bad)).toContain('非法 promptId');
    }
    await sleep(200);
    expect((await messagesOf(c, s.id)).length).toBe(before);
    expect(runsOf(dataDir, s.id)).toHaveLength(1);
  }, 30000);
});

describe('F05 审批关联、取消、事件与删除（生产链路）', () => {
  it('M6 权限卡挂着时的快照：行是 awaiting-approval，approval.requestId 等于广播的 requestId，卡片 meta.toolUseId 等于行的 toolUseId', async () => {
    const { c } = await boot();
    const s = (await c.call('chat.sessions.create', {})).result;
    expect((await c.call('chat.prompt', { sessionId: s.id, providerId: '__fake__', text: SKILL_WRITE('m6.txt') })).result).toEqual({ ok: true });
    await waitFor('权限卡', () => cardsOf(c, s.id).length === 1);
    const card = cardsOf(c, s.id)[0].params;
    const snap = (await c.call('chat.runs.snapshot', { sessionId: s.id })).result;
    expect(snap.epoch).toBe(1);
    expect(snap.runs).toMatchObject([{ sessionId: s.id, state: 'running', step: 'tools', generation: 1, epoch: 1, toolBatches: 1, origin: { kind: 'user' } }]);
    expect(snap.executions).toMatchObject([{ state: 'awaiting-approval', started: true, name: 'file_write', delivered: false, approval: { state: 'pending', requestId: card.requestId, kind: 'file-write', priorAllows: 0 } }]);
    expect(snap.executions[0].toolUseId).toBe(card.meta.toolUseId);
    // 快照不带工具入参与输出正文
    expect(JSON.stringify(snap)).not.toContain('"content"');
    // 非法的会话 id 被拒
    expect((await c.call('chat.runs.snapshot', { sessionId: '../x' })).error).toBeDefined();
  }, 30000);

  it('M5 权限卡挂着时 chat.cancel：账本 cancelled / cancelled-during-run，落库 status 是 cancelled，文件没写，run 记 cancelled / user-stop', async () => {
    const { c, dataDir } = await boot();
    const s = (await c.call('chat.sessions.create', {})).result;
    await c.call('chat.prompt', { sessionId: s.id, providerId: '__fake__', text: SKILL_WRITE('m5.txt') });
    await waitFor('权限卡', () => cardsOf(c, s.id).length === 1);
    expect((await c.call('chat.cancel', { sessionId: s.id })).error).toBeUndefined();
    await waitFor('回合报已取消', () => eventsOf(c, s.id).some(e => e.kind === 'error' && e.message === '已取消'));
    const results = (await messagesOf(c, s.id)).flatMap(x => x.parts).filter(p => p.type === 'toolResult').map(p => p.value);
    expect(results).toMatchObject([{ output: '[已取消]', success: false, status: 'cancelled' }]);
    expect(existsSync(join(dataDir, 'skills', 'f05', 'm5.txt'))).toBe(false);
    expect(execsOf(dataDir, s.id)).toMatchObject([{ state: 'cancelled', end_kind: 'cancelled-during-run', started: 1, approval_state: 'denied', approval_reason: 'cancelled' }]);
    expect(execsOf(dataDir, s.id)[0].delivered_at).not.toBeNull();
    // error 事件广播出来时 run 的终态已经提交
    expect(runsOf(dataDir, s.id)).toMatchObject([{ state: 'cancelled', active: null, stop_reason: 'user-stop' }]);
  }, 30000);

  it('M11 run 事件都带 run（id / generation / epoch）；第二次运行 generation 是 2、epoch 不变', async () => {
    const { c } = await boot();
    const s = (await c.call('chat.sessions.create', {})).result;
    await c.call('chat.prompt', { sessionId: s.id, providerId: '__fake__', text: '第一次' });
    await waitFor('第一次跑完', () => turnEnded(c, s.id));
    await waitFor('第二次被接受', async () => !(await c.call('chat.prompt', { sessionId: s.id, providerId: '__fake__', text: '第二次' })).error);
    await waitFor('第二次跑完', () => turnEnded(c, s.id, 2));
    const notes = c.notifications.filter(n => n.method === 'chat.event' && n.params.sessionId === s.id && n.params.event !== undefined);
    expect(notes.length).toBeGreaterThan(2);
    for (const n of notes) expect(n.params.run, JSON.stringify(n.params.event)).toMatchObject({ id: expect.any(String), generation: expect.any(Number), epoch: 1 });
    const gens = [...new Set(notes.map(n => n.params.run.generation))];
    expect(gens).toEqual([1, 2]);
    expect([...new Set(notes.map(n => n.params.run.id))]).toHaveLength(2);
    // 每次运行的最后一个事件是 turnEnd，属于它自己那次运行
    for (const g of gens) expect(notes.filter(n => n.params.run.generation === g).pop()!.params.event.kind).toBe('turnEnd');
  }, 30000);

  it('M12 删除会话：两张账本表里该会话 0 行（运行中的先停下），不动别的会话', async () => {
    const { c, dataDir } = await boot();
    const keep = (await c.call('chat.sessions.create', {})).result;
    const gone = (await c.call('chat.sessions.create', {})).result;
    await c.call('chat.prompt', { sessionId: keep.id, providerId: '__fake__', text: '留下的' });
    await waitFor('留下的跑完', () => turnEnded(c, keep.id));
    await c.call('chat.prompt', { sessionId: gone.id, providerId: '__fake__', text: SKILL_WRITE('m12.txt') });
    await waitFor('权限卡', () => cardsOf(c, gone.id).length === 1);
    expect(runsOf(dataDir, gone.id)).toHaveLength(1);
    expect(execsOf(dataDir, gone.id)).toHaveLength(1);
    expect((await c.call('chat.sessions.delete', { sessionId: gone.id, confirm: true })).error).toBeUndefined();
    expect(runsOf(dataDir, gone.id)).toEqual([]);
    expect(execsOf(dataDir, gone.id)).toEqual([]);
    expect(runsOf(dataDir, keep.id)).toMatchObject([{ state: 'completed' }]);
    expect(activeRuns(dataDir)).toBe(0);
  }, 30000);
});

describe('F05 定时任务复用同一入口（生产链路）', () => {
  it('M10 cron.runNow：跑完的 last_status 是 ok、失败的是 error；run 的来源记着是哪个任务；经 RPC 提交的 prompt 标不成定时任务', async () => {
    const { c, dataDir } = await boot({}, seedFakeDefault);
    const okJob = (await c.call('cron.create', { name: '好的', prompt: '你好', scheduleKind: 'interval', scheduleValue: '60' })).result;
    const badJob = (await c.call('cron.create', { name: '坏的', prompt: '__fail__ 限流', scheduleKind: 'interval', scheduleValue: '60' })).result;
    await c.call('cron.runNow', { id: okJob.id });
    await c.call('cron.runNow', { id: badJob.id });
    const job = async (id: string): Promise<any> => ((await c.call('cron.list', {})).result as any[]).find(j => j.id === id);
    await waitFor('两个任务都有终态', async () => (await job(okJob.id)).lastStatus === 'ok' && String((await job(badJob.id)).lastStatus).startsWith('error'));
    const okSession = (await job(okJob.id)).lastSessionId as string;
    expect(runsOf(dataDir, okSession)).toMatchObject([{ origin: 'cron', origin_ref: okJob.id, state: 'completed', prompt_id: `cron:${okSession}` }]);
    expect(runsOf(dataDir, (await job(badJob.id)).lastSessionId)).toMatchObject([{ origin: 'cron', origin_ref: badJob.id, state: 'failed' }]);
    // 第三个实参只有进程内调用给得了：RPC 入参里塞 origin 没有用
    const s = (await c.call('chat.sessions.create', {})).result;
    await c.call('chat.prompt', { sessionId: s.id, providerId: '__fake__', text: '你好', origin: { kind: 'cron', ref: 'X' } });
    await waitFor('用户会话跑完', () => turnEnded(c, s.id));
    expect(runsOf(dataDir, s.id)).toMatchObject([{ origin: 'user', origin_ref: null }]);
  }, 30000);
});

describe('F05 关停与再次启动（生产链路）', () => {
  it('M7 / M9b 权限卡挂着时 close，同一数据根重开：第一代 run 是 cancelled / shutdown、结果 [已取消]；第二代代次加一、没有东西要恢复、消息不变', async () => {
    const first = await boot();
    const s = (await first.c.call('chat.sessions.create', {})).result;
    await first.c.call('chat.prompt', { sessionId: s.id, providerId: '__fake__', text: SKILL_WRITE('m7.txt') });
    await waitFor('权限卡', () => cardsOf(first.c, s.id).length === 1);
    await first.close();
    expect(runsOf(first.dataDir, s.id)).toMatchObject([{ state: 'cancelled', active: null, stop_reason: 'shutdown' }]);
    expect(execsOf(first.dataDir, s.id)).toMatchObject([{ state: 'cancelled', end_kind: 'cancelled-during-run' }]);
    expect(execsOf(first.dataDir, s.id)[0].delivered_at).not.toBeNull();
    expect(readDb(first.dataDir, 'SELECT epoch, close_kind FROM engine_instances')).toEqual([{ epoch: 1, close_kind: 'shutdown' }]);
    const before = readDb(first.dataDir, 'SELECT id, parts_json FROM messages WHERE session_id=? ORDER BY created_at, id', s.id);
    expect(before.map(r => JSON.parse(r.parts_json)).flat().filter((p: any) => p.type === 'toolResult').map((p: any) => [p.value.output, p.value.status])).toEqual([['[已取消]', 'cancelled']]);

    const again = await boot({ dataDir: first.dataDir });
    expect((await again.c.call('chat.runs.snapshot', {})).result).toMatchObject({ epoch: 2, runs: [], executions: [] });
    expect(readDb(first.dataDir, 'SELECT epoch, close_kind FROM engine_instances ORDER BY epoch')).toEqual([{ epoch: 1, close_kind: 'shutdown' }, { epoch: 2, close_kind: null }]);
    expect(readDb(first.dataDir, 'SELECT id, parts_json FROM messages WHERE session_id=? ORDER BY created_at, id', s.id)).toEqual(before);
    expect(runsOf(first.dataDir, s.id)).toMatchObject([{ state: 'cancelled', stop_reason: 'shutdown', recovered_epoch: null }]);
    expect(readDb(first.dataDir, "SELECT COUNT(*) n FROM audit_logs WHERE event_type='run.recovered'")).toEqual([{ n: 0 }]);
  }, 30000);

  it('M8 chat.prompt 卡在连 MCP 时 close（时限内停不下），重开：run 记 interrupted / shutdown-timeout，没有 user 消息，同一 promptId 再提交起新 run；全程没有「not open」', async () => {
    // F09现在会dispose在途HTTP连接。这里明确注入不响应dispose的client，保持M8要测的关停超时/迟到恢复前提。
    // 原有starting/interrupted/无重复消息/无关闭后写库断言全部保留；实际HTTP及时取消另由M8a覆盖。
    const ignoreDispose = vi.spyOn(McpHttpClient.prototype, 'dispose').mockImplementation(() => Promise.resolve());
    cleanups.push(() => ignoreDispose.mockRestore());
    // 握手永远不应答的本地 MCP：chat.prompt 卡在 ensureForRun，直到启动超时（1 秒），不理会 abort
    const server = createServer((req) => { req.resume(); });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    cleanups.push(() => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    cleanups.push(() => { warn.mockRestore(); error.mockRestore(); });

    const first = await boot({}, dir => {
      mkdirSync(join(dir, 'mcp-servers'), { recursive: true });
      writeFileSync(join(dir, 'mcp-servers', 'servers.json'), JSON.stringify({ mcpServers: { hang: { url, startupTimeoutSeconds: 1 } } }), 'utf8');
    });
    const s = (await first.c.call('chat.sessions.create', {})).result;
    const promptId = 'f05-m8-0001';
    void first.c.call('chat.prompt', { sessionId: s.id, providerId: '__fake__', text: '你好', promptId });
    await waitFor('run 行已建（starting）', () => runsOf(first.dataDir, s.id).length === 1);
    expect(runsOf(first.dataDir, s.id)).toMatchObject([{ state: 'starting', active: 1, prompt_id: promptId, user_message_id: null }]);
    await first.close({ graceMs: 50 });
    // 关停时限内没停下：行原样留着
    expect(runsOf(first.dataDir, s.id)).toMatchObject([{ state: 'starting', active: 1 }]);
    // 等卡住的处理器醒来（MCP 启动超时 1 秒）：它晚到的收尾不该再碰已经关掉的库
    await sleep(1600);
    const noisy = [...warn.mock.calls, ...error.mock.calls].map(a => a.map(String).join(' ')).filter(l => /not open|database connection/i.test(l));
    expect(noisy).toEqual([]);

    // 重开之前把那台不应答的 MCP 摘掉
    writeFileSync(join(first.dataDir, 'mcp-servers', 'servers.json'), JSON.stringify({ mcpServers: {} }), 'utf8');
    const again = await boot({ dataDir: first.dataDir });
    expect(runsOf(first.dataDir, s.id)).toMatchObject([{ state: 'interrupted', active: null, stop_reason: 'shutdown-timeout', recovered_epoch: 2, prompt_id: null }]);
    expect(await messagesOf(again.c, s.id)).toEqual([]);
    const r = await again.c.call('chat.prompt', { sessionId: s.id, providerId: '__fake__', text: '你好', promptId });
    expect(r.error).toBeUndefined();
    expect(r.result).toMatchObject({ ok: true, duplicate: false, generation: 2 });
    await waitFor('新 run 跑完', () => turnEnded(again.c, s.id));
    expect(runsOf(first.dataDir, s.id).map(x => [x.generation, x.state, x.epoch])).toEqual([[1, 'interrupted', 1], [2, 'completed', 2]]);
    expect(userPrompts(await messagesOf(again.c, s.id))).toHaveLength(1);
  }, 30000);

  it('M8a HTTP MCP在途握手关停：实际dispose在短时限内取消，重开不恢复假中断，同ID可重试且只写一次', async () => {
    let requests = 0;
    const server = createServer(req => { requests++; req.resume(); });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    cleanups.push(() => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    cleanups.push(() => { warn.mockRestore(); error.mockRestore(); });
    const first = await boot({}, dir => {
      mkdirSync(join(dir, 'mcp-servers'), { recursive: true });
      writeFileSync(join(dir, 'mcp-servers', 'servers.json'), JSON.stringify({ mcpServers: { hang: { url, startupTimeoutSeconds: 2 } } }), 'utf8');
    });
    const s = (await first.c.call('chat.sessions.create', {})).result;
    const promptId = 'f09-m8a-0001';
    void first.c.call('chat.prompt', { sessionId: s.id, providerId: '__fake__', text: '你好', promptId });
    await waitFor('HTTP握手实际开始', () => requests > 0);
    expect(runsOf(first.dataDir, s.id)).toMatchObject([{ state: 'starting', active: 1, user_message_id: null }]);
    await first.close({ graceMs: 50 });
    expect(runsOf(first.dataDir, s.id)).toMatchObject([{ state: 'cancelled', active: null, stop_reason: 'shutdown', user_message_id: null, prompt_id: null }]);
    expect(readDb(first.dataDir, 'SELECT epoch, close_kind FROM engine_instances')).toEqual([{ epoch: 1, close_kind: 'shutdown' }]);
    await sleep(100);
    expect([...warn.mock.calls, ...error.mock.calls].map(a => a.map(String).join(' ')).filter(l => /not open|database connection/i.test(l))).toEqual([]);
    writeFileSync(join(first.dataDir, 'mcp-servers', 'servers.json'), JSON.stringify({ mcpServers: {} }), 'utf8');
    const again = await boot({ dataDir: first.dataDir });
    expect(await messagesOf(again.c, s.id)).toEqual([]);
    expect(readDb(first.dataDir, "SELECT COUNT(*) n FROM audit_logs WHERE event_type='run.recovered'")).toEqual([{ n: 0 }]);
    const result = await again.c.call('chat.prompt', { sessionId: s.id, providerId: '__fake__', text: '你好', promptId });
    expect(result.error).toBeUndefined();
    expect(result.result).toMatchObject({ ok: true, duplicate: false, generation: 2 });
    await waitFor('新run完成', () => turnEnded(again.c, s.id));
    expect(runsOf(first.dataDir, s.id).map(x => [x.generation, x.state, x.epoch])).toEqual([[1, 'cancelled', 1], [2, 'completed', 2]]);
    expect(userPrompts(await messagesOf(again.c, s.id))).toHaveLength(1);
  }, 30000);

  it('M9 旧数据库升级：三张新表建好，旧消息逐字段不变，没有账本行的旧孤儿 toolUse 不被补结果，running 的定时任务状态收口，能正常提问', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dm-f05-m9-'));
    // 按内容找 F05 那条迁移，用它之前的迁移建一个「升级前」的库
    const at = MIGRATIONS.findIndex(x => x.includes('CREATE TABLE agent_runs'));
    expect(at).toBeGreaterThan(0);
    const old = new Database(join(dataDir, 'minis.db'));
    old.pragma('journal_mode = WAL');
    runMigrations(old, MIGRATIONS.slice(0, at));
    expect(old.pragma('user_version', { simple: true })).toBe(at);
    const chat = new ChatStore(old);
    const s = chat.createSession('升级前的会话');
    const t = chat.nowEpoch() - 100;
    // F11B：现在的 ChatStore.appendMessage 会先查 session_lifecycle（F05 之后的迁移才建），升级前的库里没有这张表——
    // 这两条旧消息直接按行写入（列与 appendMessage 写的相同）
    const put = (id: string, role: string, parts: ContentPart[], createdAt: number, sortOrder: number): void => {
      old.prepare(`INSERT INTO messages (id, session_id, role, parts_json, created_at, updated_at, sort_order, stream_interrupt_count, origin_device_id, created_locally_at)
        VALUES (?,?,?,?,?,?,?,0,'local',?)`).run(id, s.id, role, serializeParts(parts), createdAt, createdAt, sortOrder, createdAt);
    };
    put('OLD-U', 'user', [{ type: 'text', value: '升级前的提问' }], t, 0);
    put('OLD-A', 'assistant', [{ type: 'toolUse', value: { toolUseId: 'OLD-T', name: 'shell_execute', input: '{}' } }], t + 1, 1);
    old.prepare("INSERT INTO cron_jobs (id, name, prompt, schedule_kind, schedule_value, enabled, last_status, created_at, updated_at) VALUES ('OLD-JOB','旧任务','p','interval','60',0,'running',1,1)").run();
    const before = JSON.stringify(old.prepare('SELECT * FROM messages ORDER BY created_at').all());
    old.close();

    const m = await boot({ dataDir }, seedFakeDefault);
    expect(readDb(dataDir, 'PRAGMA user_version')).toEqual([{ user_version: MIGRATIONS.length }]);
    expect(readDb(dataDir, "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('engine_instances','agent_runs','tool_executions') ORDER BY name").map(r => r.name))
      .toEqual(['agent_runs', 'engine_instances', 'tool_executions']);
    expect(JSON.stringify(readDb(dataDir, 'SELECT * FROM messages ORDER BY created_at'))).toBe(before);
    expect(readDb(dataDir, 'SELECT last_status FROM cron_jobs')).toEqual([{ last_status: 'error: 运行被中断（应用退出或重启），没有自动重跑' }]);
    expect(readDb(dataDir, 'SELECT epoch FROM engine_instances')).toEqual([{ epoch: 1 }]);
    expect(readDb(dataDir, 'SELECT COUNT(*) n FROM agent_runs')).toEqual([{ n: 0 }]);
    // 旧会话里接着提问：照常起 run；旧的孤儿调用没有被补结果（请求侧由占位兜住）
    const r = await m.c.call('chat.prompt', { sessionId: s.id, providerId: '__fake__', text: '升级后的提问', promptId: 'f05-m9' });
    expect(r.result).toMatchObject({ ok: true, generation: 1, duplicate: false });
    await waitFor('升级后的第一轮跑完', () => turnEnded(m.c, s.id));
    const msgs = await messagesOf(m.c, s.id);
    expect(msgs.slice(0, 2).map(x => x.id)).toEqual(['OLD-U', 'OLD-A']);
    expect(msgs.flatMap(x => x.parts).filter(p => p.type === 'toolResult')).toEqual([]);
  }, 30000);

  it('M14 恢复里的写入失败时引擎照常启动；没收口的活动行不卡住会话，下次提问 / 下次启动时收口', async () => {
    const first = await boot({}, seedFakeDefault);
    const a = (await first.c.call('chat.sessions.create', {})).result;
    const b = (await first.c.call('chat.sessions.create', {})).result;
    await first.close();
    // 旁路连接：留一条前代的活动 run（崩溃留下的样子）、一个 running 的定时任务，再让恢复要做的两种写入都失败
    const side = new Database(join(first.dataDir, 'minis.db'));
    side.prepare("INSERT INTO agent_runs (id, session_id, generation, epoch, state, active, step, user_message_id, created_at, updated_at) VALUES ('STALE',?,1,1,'running',1,'model','M-GONE',1,1)").run(a.id);
    side.prepare("INSERT INTO cron_jobs (id, name, prompt, schedule_kind, schedule_value, enabled, last_status, created_at, updated_at) VALUES ('JOB','任务','p','interval','60',0,'running',1,1)").run();
    side.exec("CREATE TRIGGER f05_m14_runs BEFORE UPDATE ON agent_runs WHEN NEW.state='interrupted' BEGIN SELECT RAISE(ABORT, '注入：run 收口失败'); END");
    side.exec("CREATE TRIGGER f05_m14_cron BEFORE UPDATE ON cron_jobs BEGIN SELECT RAISE(ABORT, '注入：定时任务收口失败'); END");
    side.close();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    cleanups.push(() => warn.mockRestore());

    // 第二代：启动成功，RPC 可用，别的会话能正常提问
    const again = await boot({ dataDir: first.dataDir });
    expect(warn.mock.calls.map(x => String(x[0])).some(l => l.includes('启动恢复') && l.includes('失败'))).toBe(true);
    await again.c.call('chat.prompt', { sessionId: b.id, providerId: '__fake__', text: '你好' });
    await waitFor('会话 B 跑完', () => turnEnded(again.c, b.id));
    // 恢复确实失败了，没有被悄悄吞成成功
    expect(runsOf(first.dataDir, a.id)).toMatchObject([{ id: 'STALE', state: 'running', active: 1 }]);
    expect(readDb(first.dataDir, "SELECT last_status FROM cron_jobs WHERE id='JOB'")).toEqual([{ last_status: 'running' }]);
    // 快照里它是前代的活动行：消费方按「epoch 小于快照的 epoch」判它不在跑
    const snap = (await again.c.call('chat.runs.snapshot', {})).result;
    expect(snap.epoch).toBe(2);
    expect(snap.runs.filter((r: any) => r.runId === 'STALE')).toMatchObject([{ epoch: 1, state: 'running' }]);

    // 触发器撤掉后在会话 A 提问：接受并跑完，原来那行被收成 interrupted
    const side2 = new Database(join(first.dataDir, 'minis.db'));
    side2.exec('DROP TRIGGER f05_m14_runs; DROP TRIGGER f05_m14_cron;');
    side2.close();
    const r = await again.c.call('chat.prompt', { sessionId: a.id, providerId: '__fake__', text: '你好', promptId: 'f05-m14' });
    expect(r.error).toBeUndefined();
    expect(r.result).toMatchObject({ generation: 2, duplicate: false });
    await waitFor('会话 A 跑完', () => turnEnded(again.c, a.id));
    expect(runsOf(first.dataDir, a.id)).toMatchObject([
      { id: 'STALE', state: 'interrupted', active: null, stop_reason: 'engine-crash', recovered_epoch: 2 },
      { generation: 2, state: 'completed', epoch: 2 },
    ]);
    await again.close();

    // 第三代：定时任务状态收口，没有活动 run
    await boot({ dataDir: first.dataDir });
    expect(readDb(first.dataDir, "SELECT last_status FROM cron_jobs WHERE id='JOB'")[0].last_status).toMatch(/^error: 运行被中断/);
    expect(activeRuns(first.dataDir)).toBe(0);
  }, 40000);
});

// ---------- 以下是复核修复补的用例（M15–M18；上面的用例文本不动） ----------

/** 握手永远不应答的本地 MCP：chat.prompt 卡在 ensureForRun，直到启动超时，不理会 abort（M8 的同一个办法）。
 *  返回往数据根里铺配置的 seed。MCP 连接失败的告警一并静音。 */
async function hangingMcp(startupTimeoutSeconds: number): Promise<(dir: string) => void> {
  const server = createServer((req) => { req.resume(); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  cleanups.push(() => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  cleanups.push(() => { warn.mockRestore(); error.mockRestore(); });
  return dir => {
    mkdirSync(join(dir, 'mcp-servers'), { recursive: true });
    writeFileSync(join(dir, 'mcp-servers', 'servers.json'), JSON.stringify({ mcpServers: { hang: { url, startupTimeoutSeconds } } }), 'utf8');
  };
}

describe('F05 起跑前结束的 run（生产链路）', () => {
  it('M15 连 MCP 期间 chat.cancel：run 记 cancelled / user-stop、不占 promptId、活动行与内存占位都放掉——同一会话同一 promptId 再提交起第二次运行并跑完', async () => {
    const { c, dataDir } = await boot({}, await hangingMcp(1));
    const s = (await c.call('chat.sessions.create', {})).result;
    const p = { sessionId: s.id, providerId: '__fake__', text: '你好', promptId: 'f05-m15-0001' };
    const first = c.call('chat.prompt', p);
    await waitFor('run 行已建（starting）', () => runsOf(dataDir, s.id).length === 1);
    expect((await c.call('chat.cancel', { sessionId: s.id })).error).toBeUndefined();
    const r1 = await first;
    expect(r1.error.message).toContain('会话已取消');
    // 起跑前的收尾把终态落进了账本：不是停在 starting / active
    expect(runsOf(dataDir, s.id)).toMatchObject([{ state: 'cancelled', active: null, step: 'finished', stop_reason: 'user-stop', prompt_id: null, user_message_id: null }]);
    expect(activeRuns(dataDir)).toBe(0);
    expect(await messagesOf(c, s.id)).toEqual([]);

    // 这条消息没有被接收过：同一个 promptId 再提交不是 duplicate，也不是「该会话正在运行中」
    const r2 = await c.call('chat.prompt', p);
    expect(r2.error).toBeUndefined();
    expect(r2.result).toMatchObject({ ok: true, duplicate: false, generation: 2, state: 'running' });
    await waitFor('第二次运行跑完', () => turnEnded(c, s.id), 15_000);
    expect(runsOf(dataDir, s.id).map(x => [x.generation, x.state, x.prompt_id])).toEqual([[1, 'cancelled', null], [2, 'completed', p.promptId]]);
    expect(userPrompts(await messagesOf(c, s.id))).toHaveLength(1);
  }, 30000);

  it('M18 run 还在 starting 时重复提交同一 promptId：不拿一个没落消息的 run 去答 duplicate，等它的起跑结果——原提交被取消，重复提交方收到同一个错误，这条消息可以再提交', async () => {
    const m = await boot({}, await hangingMcp(2));
    const c2 = await second(m);
    const s = (await m.c.call('chat.sessions.create', {})).result;
    const p = { sessionId: s.id, providerId: '__fake__', text: '你好', promptId: 'f05-m18-0001' };
    const first = m.c.call('chat.prompt', p);
    await waitFor('run 行已建（starting）', () => runsOf(m.dataDir, s.id).length === 1);
    let answered: any;
    const dup = c2.call('chat.prompt', p).then(r => (answered = r));
    await sleep(250);
    // 重复提交还没有应答（原 run 还没落 user 消息）；也没有起第二个 run
    expect(answered).toBeUndefined();
    expect(runsOf(m.dataDir, s.id)).toMatchObject([{ state: 'starting', active: 1, prompt_id: p.promptId, user_message_id: null }]);

    expect((await m.c.call('chat.cancel', { sessionId: s.id })).error).toBeUndefined();
    const [r1, r2] = await Promise.all([first, dup]);
    expect(r1.error.message).toContain('会话已取消');
    // 重复提交方同样被告知这条消息没有发出去——不是 { ok: true, duplicate: true }
    expect(r2.result).toBeUndefined();
    expect(r2.error.message).toContain('会话已取消');
    expect(runsOf(m.dataDir, s.id)).toMatchObject([{ state: 'cancelled', stop_reason: 'user-stop', prompt_id: null, user_message_id: null }]);
    expect(await messagesOf(m.c, s.id)).toEqual([]);

    // 被告知失败的一方重发同一个 promptId：正常起跑
    const r3 = await c2.call('chat.prompt', p);
    expect(r3.error).toBeUndefined();
    expect(r3.result).toMatchObject({ ok: true, duplicate: false, generation: 2 });
    await waitFor('重发的那次跑完', () => turnEnded(m.c, s.id), 15_000);
    expect(userPrompts(await messagesOf(m.c, s.id))).toHaveLength(1);
  }, 30000);

  it('M18b 同样落在 starting 窗口里的重复提交，原提交照常起跑：等到 user 消息落库才答 duplicate（state 不是 starting），一个 run、一条 user 消息', async () => {
    const m = await boot({}, await hangingMcp(1));
    const c2 = await second(m);
    const s = (await m.c.call('chat.sessions.create', {})).result;
    const p = { sessionId: s.id, providerId: '__fake__', text: '你好', promptId: 'f05-m18b-0001' };
    const first = m.c.call('chat.prompt', p);
    await waitFor('run 行已建（starting）', () => runsOf(m.dataDir, s.id).length === 1);
    expect(runsOf(m.dataDir, s.id)).toMatchObject([{ state: 'starting' }]);
    const [r1, r2] = await Promise.all([first, c2.call('chat.prompt', p)]);
    expect(r1.error).toBeUndefined();
    expect(r2.error).toBeUndefined();
    expect(r1.result).toMatchObject({ ok: true, duplicate: false, generation: 1 });
    expect(r2.result).toMatchObject({ ok: true, duplicate: true, generation: 1, runId: r1.result.runId });
    expect(r2.result.state).not.toBe('starting');
    await waitFor('跑完', () => turnEnded(m.c, s.id), 15_000);
    expect(runsOf(m.dataDir, s.id)).toMatchObject([{ generation: 1, state: 'completed' }]);
    expect(userPrompts(await messagesOf(m.c, s.id))).toHaveLength(1);
  }, 30000);

  it('M18c 库里一条陈旧的 starting 行占着这个 promptId（本进程并没有在起它）：不算重复——照常起跑，陈旧行被收掉、不再占 id', async () => {
    const { c, dataDir } = await boot();
    const s = (await c.call('chat.sessions.create', {})).result;
    // 旁路连接留一条「终态没写成」的样子：本代、starting、active、没有 user 消息；摘要故意与下面的提交不同
    const side = new Database(join(dataDir, 'minis.db'));
    side.prepare("INSERT INTO agent_runs (id, session_id, generation, epoch, state, active, step, prompt_id, prompt_digest, created_at, updated_at) VALUES ('STALE',?,1,1,'starting',1,'starting','f05-m18c','另一条的摘要',1,1)").run(s.id);
    side.close();
    const r = await c.call('chat.prompt', { sessionId: s.id, providerId: '__fake__', text: '你好', promptId: 'f05-m18c' });
    expect(r.error).toBeUndefined();
    expect(r.result).toMatchObject({ ok: true, duplicate: false, generation: 2, state: 'running' });
    await waitFor('跑完', () => turnEnded(c, s.id));
    expect(runsOf(dataDir, s.id)).toMatchObject([
      { id: 'STALE', state: 'failed', active: null, stop_reason: 'finalize-failed', prompt_id: null },
      { generation: 2, state: 'completed', prompt_id: 'f05-m18c' },
    ]);
    expect(userPrompts(await messagesOf(c, s.id))).toHaveLength(1);
  }, 30000);
});

describe('F05 run 收尾补送与运行心跳（生产链路）', () => {
  it('M16 结果消息的交付在库里失败（触发器让批次交付的末句抛错）：run 收尾时在同一进程里补写——那次调用的真实结果在历史里恰好一条、行已交付，run 记 failed', async () => {
    const { c, dataDir } = await boot();
    const s = (await c.call('chat.sessions.create', {})).result;
    const side = new Database(join(dataDir, 'minis.db'));
    side.exec("CREATE TRIGGER f05_m16 BEFORE UPDATE OF step ON agent_runs WHEN NEW.step='model' AND OLD.step='tools' BEGIN SELECT RAISE(ABORT, '注入：交付失败'); END");
    side.close();
    // 会话工作区里的写入免审：不弹卡，直接执行
    const r = await c.call('chat.prompt', { sessionId: s.id, providerId: '__fake__', text: toolScript('file_write', { path: 'm16.txt', content: 'M16 的内容', tool_title: '写 m16' }) });
    expect(r.error).toBeUndefined();
    await waitFor('回合以错误结束', () => eventsOf(c, s.id).some(e => e.kind === 'error'));
    expect(eventsOf(c, s.id).find(e => e.kind === 'error').message).toContain('注入：交付失败');
    expect(cardsOf(c, s.id)).toHaveLength(0);

    // 错误事件广播出来时补送已经做完（先收尾提交、后发布）
    const msgs = await messagesOf(c, s.id);
    expect(msgs.map(x => x.role)).toEqual(['user', 'assistant', 'user']);
    const toolUseId = msgs[1].parts.find(x => x.type === 'toolUse')!.value.toolUseId as string;
    const results = msgs.flatMap(x => x.parts).filter(x => x.type === 'toolResult').map(x => x.value);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ toolUseId, success: true, status: 'success' });
    expect(results[0].output).toContain('已写入');
    const rows = execsOf(dataDir, s.id);
    expect(rows).toMatchObject([{ tool_use_id: toolUseId, state: 'completed', end_kind: 'completed', started: 1, result_message_id: msgs[2].id, result_output: null }]);
    expect(rows[0].delivered_at).not.toBeNull();
    expect(runsOf(dataDir, s.id)).toMatchObject([{ state: 'failed', active: null, stop_reason: 'error' }]);
  }, 30000);

  it('M17 运行心跳接着：有活动 run 时引擎按 10 秒的间隔写 heartbeat_at（挂着一张权限卡等过一个周期），快照带出它', async () => {
    const { c, dataDir } = await boot();
    const inst = (): { started_at: number; heartbeat_at: number } => readDb(dataDir, 'SELECT started_at, heartbeat_at FROM engine_instances WHERE epoch=1')[0];
    const s = (await c.call('chat.sessions.create', {})).result;
    await c.call('chat.prompt', { sessionId: s.id, providerId: '__fake__', text: SKILL_WRITE('m17.txt') });
    await waitFor('权限卡', () => cardsOf(c, s.id).length === 1);
    // 不靠别的写入顺手更新：只有定时器到点才写。每 250ms 看一次，最多等两个半周期
    const deadline = Date.now() + 25_000;
    while (!(inst().heartbeat_at > inst().started_at)) {
      if (Date.now() > deadline) throw new Error('等待超时: 运行心跳一直没有写入');
      await sleep(250);
    }
    const { started_at, heartbeat_at } = inst();
    expect(heartbeat_at - started_at).toBeGreaterThanOrEqual(9);
    expect((await c.call('chat.runs.snapshot', {})).result.heartbeatAt).toBeGreaterThanOrEqual(heartbeat_at);
    // 心跳不改任何状态：run 还挂在那张卡上
    expect(runsOf(dataDir, s.id)).toMatchObject([{ state: 'running', active: 1 }]);
    expect(cardsOf(c, s.id)).toHaveLength(1);
  }, 45000);
});

describe('F05 M13 接线（在真实引擎上观察调用的先后与次数）与源码守卫', () => {
  const root = join(__dirname, '..', 'src', 'minisd');
  const codeOf = (rel: string): string => stripComments(readFileSync(join(root, rel), 'utf8'));
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs, out); else if (name.endsWith('.ts')) out.push(abs);
    }
    return out;
  };
  afterEach(() => { vi.restoreAllMocks(); });
  const TERMINAL = ['completed', 'failed', 'cancelled'];

  it('(a) recoverOnBoot 只调一次，在监听端口之前，写在 try 里', async () => {
    const w = watchEngine();
    await boot();
    // 一次启动只恢复一次；账本先开出新的一代，恢复用的就是它；恢复做完才开始监听端口
    expect(w.count('recoverOnBoot')).toBe(1);
    expect(w.seq(['new RunLedger', 'recoverOnBoot', 'rpc.listen'])).toEqual(['new RunLedger', 'recoverOnBoot', 'rpc.listen']);
    expectSame(w.args('recoverOnBoot')[0].ledger, w.made('new RunLedger'));
    // 恢复抛错不挡启动（按契约它不抛，装配处另兜一层）：换成一上来就抛的恢复，引擎照常起来、照常服务
    w.spy('recoverOnBoot').mockImplementationOnce(() => { throw new Error('q20：恢复炸了'); });
    const again = await boot();
    expect((await again.c.call('chat.sessions.list')).result).toEqual([]);
    expect(w.count('recoverOnBoot')).toBe(2);
  }, 30000);

  it('(b) chat.prompt 里没有裸的 chat.event 广播，终态先提交再发布；整个引擎里 chat.event 只有三个发布点', async () => {
    const w = watchEngine();
    const { c, dataDir } = await boot();
    const ledger = w.made<{ getRun(id: string): { state: string } | undefined }>('new RunLedger');
    const isRunning = w.args('new CheckpointService')[0].isSessionRunning as (sid: string) => boolean;
    // 每条 run 事件广播出去的那一刻：它带着这次运行；库里这次运行此刻是什么状态
    const published: { sessionId: string; kind: string; run: any; stateThen?: string }[] = [];
    onCall(w.spy('rpc.broadcast'), (_self, [method, params]: any[]) => {
      if (method !== 'chat.event' || params.event === undefined) return;
      published.push({ sessionId: params.sessionId, kind: params.event.kind, run: params.run, stateThen: params.run ? ledger.getRun(params.run.id)?.state : undefined });
    });
    // 每次落终态的那一刻：这个会话的占位还在（先落终态，再放占位）
    const heldAtEnd: boolean[] = [];
    onCall(w.spy('run.end'), (_self, [ref]: any[]) => { heldAtEnd.push(isRunning(ref.sessionId)); });
    const idle = (sid: string): Promise<void> => waitFor(`会话 ${sid} 收尾`, () => !isRunning(sid) && runsOf(dataDir, sid).every(r => TERMINAL.includes(r.state)));
    const prompt = async (text: string): Promise<string> => {
      const s = (await c.call('chat.sessions.create', {})).result;
      expect((await c.call('chat.prompt', { sessionId: s.id, providerId: '__fake__', text })).error).toBeUndefined();
      await idle(s.id);
      return s.id as string;
    };

    const ok = await prompt('你好');                                  // 循环以 turnEnd 收尾
    const failed = await prompt('__fail__ 模拟限流');                  // 循环以 error 事件收尾
    w.spy('runAgentLoop').mockImplementationOnce(async function*() { throw new Error('q20：循环炸了'); });
    const thrown = await prompt('你好');                              // 循环自己抛错：catch 那条路
    w.spy('runAgentLoop').mockImplementationOnce(async function*() { /* 什么事件都不发就结束 */ });
    const silent = await prompt('你好');                              // 没有终止事件：finally 兜底

    // 没有裸广播：每条 run 事件都带着它属于哪次运行
    expect(published.length).toBeGreaterThan(4);
    for (const p of published) expect(p.run, `${p.sessionId} ${p.kind}`).toMatchObject({ id: expect.any(String), generation: 1, epoch: expect.any(Number) });
    // 终态先提交再发布：终止事件发出去时库里已是终态；之前的事件发出去时还在 running
    for (const p of published) {
      if (p.kind === 'turnEnd' || p.kind === 'error') expect(TERMINAL, `${p.sessionId} ${p.kind}`).toContain(p.stateThen);
      else expect(p.stateThen, `${p.sessionId} ${p.kind}`).toBe('running');
    }
    const lastOf = (sid: string): string | undefined => published.filter(p => p.sessionId === sid).pop()?.kind;
    expect([lastOf(ok), lastOf(failed), lastOf(thrown), lastOf(silent)]).toEqual(['turnEnd', 'error', 'error', undefined]);
    expect([ok, failed, thrown, silent].map(sid => runsOf(dataDir, sid).map(r => r.state))).toEqual([['completed'], ['failed'], ['failed'], ['failed']]);
    expect(runsOf(dataDir, silent)[0].stop_detail).toBe('运行结束时没有终止事件');
    // 四次运行各落一次终态，落的时候占位都还在
    expect(heldAtEnd).toEqual([true, true, true, true]);

    const sites: string[] = [];
    for (const f of walk(root)) {
      const code = stripComments(readFileSync(f, 'utf8'));
      for (const hit of code.matchAll(/broadcast\('chat\.event',\s*([^\n]{0,40})/g)) sites.push(hit[1]);
    }
    expect(sites).toHaveLength(3);
    expect(sites.filter(x => x.startsWith("{ kind: 'synced'"))).toHaveLength(2);
    expect(sites.filter(x => x.startsWith('{ sessionId: r.sessionId, event, run:'))).toHaveLength(1);
  }, 60000);

  it('(d) chat.prompt 的幂等检查到 beginRun、再到占位之间没有 await（并发的同 promptId 提交不会都过检查）', async () => {
    const w = watchEngine();
    // 查重之后到占 run 之前、占 run 之后到占位之后的第一句（清无人答复计数）之前：执行权有没有让出去过
    const checkToBegin = yieldProbe(w.spy('ledger.findByPrompt'), w.spy('ledger.beginRun'));
    const beginToHeld = yieldProbe(w.spy('ledger.beginRun'), w.spy('gateway.resetUnanswered'));
    const { c } = await boot();
    const isRunning = w.args('new CheckpointService')[0].isSessionRunning as (sid: string) => boolean;
    const s = (await c.call('chat.sessions.create', {})).result;
    const heldBeforeBegin: boolean[] = [];
    onCall(w.spy('ledger.beginRun'), () => { heldBeforeBegin.push(isRunning(s.id)); });
    const heldWhenReset: boolean[] = [];
    onCall(w.spy('gateway.resetUnanswered'), (_self, [sid]: any[]) => { heldWhenReset.push(isRunning(sid)); });
    const from = callMark();
    expect((await c.call('chat.prompt', { sessionId: s.id, providerId: '__fake__', text: '你好', promptId: 'q20-m13-d-0001' })).error).toBeUndefined();
    await waitFor('回合跑完', () => turnEnded(c, s.id));
    // 次序：查重 → 占 run → 占位；占位在清计数那一句之前已经完成
    expect(w.seq(['ledger.findByPrompt', 'ledger.beginRun', 'gateway.resetUnanswered'], from)).toEqual(['ledger.findByPrompt', 'ledger.beginRun', 'gateway.resetUnanswered']);
    expect(heldBeforeBegin).toEqual([false]);
    expect(heldWhenReset).toEqual([true]);
    // 中间没有让出过执行权：同一拍里到达的第二帧插不进来
    expect(checkToBegin).toEqual([false]);
    expect(beginToHeld).toEqual([false]);
  }, 30000);

  it('(e) 四处收尾 / 启动接线都在：心跳只起一次；恢复补写过的会话在同步协调器启动之后各标一次脏；起跑前失败先落 run 终态再放占位；run 收尾先补送未交付批次再落终态', async () => {
    const w = watchEngine();
    // 让启动恢复报「补写过两个会话」：装配处要在同步协调器启动之后给它们各标一次脏（标脏本身换成只记录）
    w.spy('recoverOnBoot').mockImplementationOnce(() => ({ epoch: 1, runs: [], batches: [], cronJobs: [], failed: [], sessions: ['Q20-RECOVERED-1', 'Q20-RECOVERED-2'] }));
    w.spy('sync.onDirty').mockImplementationOnce(() => undefined).mockImplementationOnce(() => undefined);
    const { c, dataDir } = await boot();
    expect(w.count('ledger.startHeartbeat')).toBe(1);
    expect(w.spy('sync.onDirty').mock.calls).toEqual([['Q20-RECOVERED-1'], ['Q20-RECOVERED-2']]);
    expect(w.seq(['sync.start', 'sync.onDirty'])).toEqual(['sync.start', 'sync.onDirty', 'sync.onDirty']);

    const ledger = w.made<{ getRun(id: string): { state: string } | undefined }>('new RunLedger');
    const isRunning = w.args('new CheckpointService')[0].isSessionRunning as (sid: string) => boolean;
    const heldAtEnd: boolean[] = [];
    onCall(w.spy('run.end'), (_self, [ref]: any[]) => { heldAtEnd.push(isRunning(ref.sessionId)); });

    // 起跑前（连 MCP）失败：先落 run 的终态（那一刻占位还在），等在这次起跑上的重复提交拿到同一个错误时终态已经在库里、占位已放
    let failConnect!: (e: Error) => void;
    w.spy('mcp.ensureForRun').mockImplementationOnce(() => new Promise<void>((_res, rej) => { failConnect = rej; }));
    const a = (await c.call('chat.sessions.create', {})).result;
    const submit = { sessionId: a.id, providerId: '__fake__', text: '你好', promptId: 'q20-m13-e-0001' };
    const first = c.call('chat.prompt', submit);
    await waitFor('起跑停在连 MCP', () => runsOf(dataDir, a.id).length === 1);
    const runId = runsOf(dataDir, a.id)[0].id as string;
    const failedLaunch = watchLaunch(w, runId, () => ({ state: ledger.getRun(runId)?.state, held: isRunning(a.id) }));
    cleanups.push(() => failedLaunch.stop());
    expect(ledger.getRun(runId)?.state).toBe('starting');
    const dup = c.call('chat.prompt', submit).then(r => ({ r, stateThen: ledger.getRun(runId)?.state, heldThen: isRunning(a.id) }));
    await sleep(50);
    failConnect(new Error('q20：连不上'));
    expect((await first).error?.message).toContain('q20：连不上');
    const dupSeen = await dup;
    expect(dupSeen.r.error?.message).toContain('q20：连不上');
    expect(failedLaunch.spy.mock.calls).toEqual([[{ state: 'failed', held: true }]]);
    expect(dupSeen.stateThen).toBe('failed');
    expect(dupSeen.heldThen).toBe(false);
    expect(heldAtEnd).toEqual([true]);
    expect(runsOf(dataDir, a.id)).toMatchObject([{ state: 'failed', active: null, stop_reason: 'start-failed', prompt_id: null }]);

    // 起跑成功：等在这次起跑上的重复提交，要到 user 消息落库（run 进了 running）之后才拿到 duplicate
    let connected!: () => void;
    w.spy('mcp.ensureForRun').mockImplementationOnce(() => new Promise<void>(res => { connected = res; }));
    const b = (await c.call('chat.sessions.create', {})).result;
    const submitB = { sessionId: b.id, providerId: '__fake__', text: '你好', promptId: 'q20-m13-e-0002' };
    const firstB = c.call('chat.prompt', submitB);
    await waitFor('第二次起跑停在连 MCP', () => runsOf(dataDir, b.id).length === 1);
    const runB = runsOf(dataDir, b.id)[0].id as string;
    const successLaunch = watchLaunch(w, runB, () => ({ state: ledger.getRun(runB)?.state, users: userPrompts(w.args('createSyncMethods')[0].listMessages(b.id)).length }));
    cleanups.push(() => successLaunch.stop());
    const dupB = c.call('chat.prompt', submitB).then(async r => ({ r, userMessages: userPrompts(await messagesOf(c, b.id)).length }));
    await sleep(50);
    const from = callMark();
    connected();
    expect((await firstB).error).toBeUndefined();
    const dupBSeen = await dupB;
    expect(dupBSeen.r.result).toMatchObject({ ok: true, duplicate: true });
    expect(dupBSeen.r.result.state).not.toBe('starting');
    expect(dupBSeen.userMessages).toBe(1);
    expect(successLaunch.spy.mock.calls).toEqual([[{ state: 'running', users: 1 }]]);
    expect(sequence({ 'run.started': w.spy('run.started'), 'launch.settled': successLaunch.spy }, from)).toEqual(['run.started', 'launch.settled']);
    await waitFor('回合跑完', () => turnEnded(c, b.id));
    // run 收尾：先补送这个 run 没交付的批次（用的是启动恢复那一套依赖），再落终态
    expect(w.seq(['run.started', 'settleOpenBatches', 'run.end'], from)).toEqual(['run.started', 'settleOpenBatches', 'run.end']);
    const [deps, which] = w.args('settleOpenBatches');
    expect(which).toEqual({ runId: runsOf(dataDir, b.id)[0].id });
    expect(deps.ledger).toBe(ledger);
    expect(deps.effectEvidence).toBe(w.args('recoverOnBoot', 0)[0].effectEvidence);
    expect(heldAtEnd).toEqual([true, true]);
  }, 40000);

  it('(c) heartbeat_at 只出现在账本里（迁移文本除外），而且没有按它比较大小的 SQL', () => {
    const users = walk(root).filter(f => stripComments(readFileSync(f, 'utf8')).includes('heartbeat_at')).map(f => f.slice(root.length + 1).replace(/\\/g, '/')).sort();
    expect(users).toEqual(['store/db.ts', 'store/run-ledger.ts']);
    const ledger = codeOf('store/run-ledger.ts');
    // `!== null` 是取值时的空判断，不是比较大小；SQL 里的 != 后面不会再跟一个 =
    expect(ledger).not.toMatch(/heartbeat_at\s*(<|>|!=(?!=)|BETWEEN)/i);
    expect(ledger).not.toMatch(/(<|>)=?\s*\??\s*heartbeat_at/i);
    expect(ledger).not.toMatch(/ORDER BY[^'`"]*heartbeat_at/i);
    // 恢复模块不拿心跳的数值做任何比较（只把它写进一句说明里）
    expect(codeOf('agent/run-recovery.ts')).not.toMatch(/[hH]eartbeat\w*\s*(<|>)|(<|>)=?\s*\w*[hH]eartbeat/);
  });
});
