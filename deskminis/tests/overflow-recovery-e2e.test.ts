/**
 * F03 端到端：真 minisd（startMinisd）+ JSON-RPC + 本地 HTTP 假端点（按「输入 + max_tokens ≤ 上限」校验）。
 * 证的是接线：恢复事件经 chat.event 到客户端、审计三类落库、chat.contextInfo 带压缩摘录与恢复状态、
 * 重发没有完成时不把「正在重发」留到运行结束之后。受控时序用闸门（假端点挂住请求，测试放行），等事件用条件轮询。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMinisd } from '../src/minisd/index';
import { MinisPaths } from '../src/minisd/paths';
import { ModelCatalog } from '../src/minisd/providers/model-catalog';
import { openDb } from '../src/minisd/store/db';
import { ChatStore } from '../src/minisd/store/chat-store';
import type { ContextInfo } from '../src/shared/request-budget';
import type { RawMessage } from '../src/shared/types';
import { catalogFixtureF02, jsonResponse } from './runtime-model-fixture';
import { ascii, gate, summaryReplyText, type Body } from './overflow-recovery-fixture';
import { makeSeen } from '../src/minisd/sync/lifecycle';

let mock: Server;
let mockPort = 0;
interface MockHit { kind: 'main' | 'summary'; status: number; body: Body }
const hits: MockHit[] = [];
/** 被端点收下的主请求怎么回：ok = 正常回复；hold = 挂在闸门上（测试放行或取消）；unauthorized = 回 401；
 *  tool-once = 请求体里还没有工具结果时回一次 file_read 调用，有了就正常回复。 */
let accepted: 'ok' | 'hold' | 'unauthorized' | 'tool-once' = 'ok';
let held: { arrived: ReturnType<typeof gate>; release: ReturnType<typeof gate> } | undefined;
/** 端点的上限 = 这次请求的固定部分（系统提示 + 工具定义，按端点口径）+ 这么多。固定部分随真实的系统提示变，所以相对它给。 */
const HEADROOM = 24_000;
const estOf = (v: unknown): number => Math.ceil(JSON.stringify(v ?? []).length / 4);

beforeAll(async () => {
  mock = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => void (async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Body;
      const msgs = (body.messages ?? []) as Body[];
      const sse = (frames: unknown[]): void => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n');
      };
      if (msgs[0]?.role === 'system' && msgs[0].content === '你是对话摘要助手。') {
        hits.push({ kind: 'summary', status: 200, body });
        sse([{ choices: [{ index: 0, delta: { content: summaryReplyText('faithful', body) } }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }]);
        return;
      }
      const fixed = estOf(msgs.filter(m => m.role === 'system')) + estOf(body.tools);
      const requested = estOf(msgs) + estOf(body.tools) + Number(body.max_tokens ?? 0);
      const limit = fixed + HEADROOM;
      if (requested > limit) {
        hits.push({ kind: 'main', status: 400, body });
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `Invalid request: Your request exceeded model token limit: ${limit} (requested: ${requested})` } }));
        return;
      }
      if (accepted === 'unauthorized') {
        hits.push({ kind: 'main', status: 401, body });
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'invalid api key (mock)' } }));
        return;
      }
      hits.push({ kind: 'main', status: 200, body });
      if (accepted === 'hold' && held) { held.arrived.open(); await held.release.wait; }
      if (accepted === 'tool-once' && !msgs.some(m => m.role === 'tool')) {
        sse([
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_read_notes', function: { name: 'file_read', arguments: JSON.stringify({ path: 'notes.txt', tool_title: '读 notes.txt' }) } }] } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        ]);
        return;
      }
      sse([{ choices: [{ index: 0, delta: { content: 'ok' } }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }]);
    })());
  });
  await new Promise<void>(r => mock.listen(0, '127.0.0.1', () => r()));
  mockPort = (mock.address() as { port: number }).port;
  // 回环地址不参与目录 api 匹配：用保留域名，这里只把它改写回本地假端点（请求仍是真 HTTP）
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: unknown, init?: unknown) =>
    realFetch(typeof input === 'string' ? input.replace(`http://${MOCK_HOST}:${mockPort}/`, `http://127.0.0.1:${mockPort}/`) : input as never, init as never));
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await new Promise<void>(r => mock.close(() => r()));
});

const MOCK_HOST = 'f03-mock.test';
const base = (path: string) => `http://${MOCK_HOST}:${mockPort}/${path}`;

let stop: (() => Promise<void>) | undefined;
const savedFake = process.env.DESKMINIS_FAKE_PROVIDER;
afterEach(async () => {
  held?.release.open(); held = undefined; accepted = 'ok'; hits.length = 0;
  await stop?.(); stop = undefined;
  if (savedFake === undefined) delete process.env.DESKMINIS_FAKE_PROVIDER; else process.env.DESKMINIS_FAKE_PROVIDER = savedFake;
});

/** 起引擎。给了 dataDir 就在同一个数据根上再起一次（重启）。 */
async function boot(dataDir?: string) {
  const dir = dataDir ?? mkdtempSync(join(tmpdir(), 'dm-f03-e2e-'));
  const seed = new ModelCatalog(join(dir, 'models-dev-cache.json'), async () => jsonResponse(catalogFixtureF02(
    { vendorA: base('vendor-a/v1'), vendorB: base('vendor-b/v1'), tie: base('tie/v1'), loopback: `http://127.0.0.1:${mockPort}/loop/v1` }, base('plan/v1'))));
  expect(await seed.refresh(true)).toBe(true);
  process.env.DESKMINIS_TEST = '1';
  delete process.env.DESKMINIS_FAKE_PROVIDER;
  const srv = await startMinisd({ dataDir: dir, host: '127.0.0.1', port: 0 });
  stop = srv.close;
  return { ...srv, dataDir: dir };
}

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
  const call = (method: string, params?: unknown): Promise<any> => {
    const id = ++idc;
    return new Promise((res) => { pending.set(id, res); ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); });
  };
  return { ready, call, notifications, close: () => ws.close() };
}
type Client = ReturnType<typeof rpcClient>;

async function waitFor(what: string, cond: () => boolean | Promise<boolean>, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise(r => setTimeout(r, 10));
  }
}
const eventsOf = (c: Client, sessionId: string): Body[] =>
  c.notifications.filter(n => n.method === 'chat.event' && n.params?.sessionId === sessionId).map(n => n.params.event as Body);
const ended = (c: Client, sessionId: string): boolean => eventsOf(c, sessionId).some(e => e.kind === 'turnEnd' || e.kind === 'error');
const info = async (c: Client, sessionId: string): Promise<ContextInfo> => (await c.call('chat.contextInfo', { sessionId })).result as ContextInfo;
const audits = async (c: Client, sessionId: string, eventType: string): Promise<Body[]> =>
  ((await c.call('audit.list', { sessionId, eventType })).result.rows as { payload: Body }[]).map(r => r.payload);

/** 往会话里落 8 组长问答（约 25K token：手动窗口 200K 的水位不到修剪档，端点却放不下）。
 *  after 为真时接在会话已有的消息之后（每条隔 0.5 毫秒），否则落在一分钟之前。返回最后一条的时间戳。 */
function seedLongHistory(dataDir: string, sessionId: string, after = false): number {
  const db = openDb(join(dataDir, 'minis.db'));
  try {
    const store = new ChatStore(db);
    const { mx } = db.prepare('SELECT MAX(created_at) mx FROM messages WHERE session_id=?').get(sessionId) as { mx: number | null };
    let at = after ? Math.max(store.nowEpoch(), mx ?? 0) + 0.001 : store.nowEpoch() - 60;
    const step = after ? 0.0005 : 0.01;
    const add = (role: 'user' | 'assistant', text: string) =>
      store.appendMessage({ id: store.newId(), sessionId, role, parts: [{ type: 'text', value: text }], createdAt: (at += step), streamInterruptCount: 0 });
    for (let i = 1; i <= 8; i++) { add('user', `question ${i}: ${ascii(6_000)}`); add('assistant', `answer ${i}: ${ascii(6_500)}`); }
    return at;
  } finally { db.close(); }
}
/** 另开一个连接读库（引擎在跑或已关停都可以）。 */
function readRows(dataDir: string, sql: string, ...args: unknown[]): Body[] {
  const db = openDb(join(dataDir, 'minis.db'));
  try { return db.prepare(sql).all(...args) as Body[]; } finally { db.close(); }
}

/** 起引擎、建一个手动窗口 200K 的中转配置与会话；seed 为真（缺省）时先落 8 组长问答。 */
async function scenario(o: { seed?: boolean } = {}) {
  const srv = await boot();
  const c = rpcClient(srv.port, srv.authToken); await c.ready;
  const inst = (await c.call('provider.instances.create', { name: '中转', kind: 'openai-compat', baseUrl: base('relay/v1'), modelId: 'unlisted-model', apiKey: 'test-key', contextWindow: 200_000 })).result as { id: string };
  const s = (await c.call('chat.sessions.create', {})).result as { id: string };
  // 先改名：自动命名只在默认标题时动手，它的请求会混进假端点的记录
  await c.call('chat.sessions.rename', { sessionId: s.id, title: 'F03 会话' });
  await c.call('chat.sessions.setModelBinding', { sessionId: s.id, binding: `provider:${inst.id}` });
  if (o.seed !== false) seedLongHistory(srv.dataDir, s.id);
  return { srv, c, sid: s.id, binding: `provider:${inst.id}` };
}

describe('F03 端到端：同模型超窗恢复', () => {
  for (const retained of [false, true]) {
    it(`F03 integrate: remote deletion ${retained ? 'retains' : 'purges'} history but hides compact and recovery views`, async () => {
      const { srv, c, sid } = await scenario();
      try {
        expect((await c.call('chat.prompt', { sessionId: sid, text: 'hello' })).error).toBeUndefined();
        await waitFor('recovery completed', () => ended(c, sid));
        expect(await info(c, sid)).toMatchObject({ compaction: { v: 2 }, recovery: { phase: 'recovered' } });
        const ids = readRows(srv.dataDir, 'SELECT id FROM messages WHERE session_id=?', sid).map(m => String(m.id));
        const result = await c.call('sync.push', { sessionId: sid, payload: { messages: [], markers: [],
          lifecycle: { v: 1, opId: 'F03-REMOTE-DELETE', originDeviceId: 'remote', at: 1, seen: makeSeen(retained ? [] : ids) } } });
        expect(result.error).toBeUndefined();
        const hidden = await info(c, sid);
        expect('compaction' in hidden).toBe(false);
        expect('recovery' in hidden).toBe(false);
        if (retained) {
          expect((await c.call('chat.sessions.restore', { sessionId: sid, confirm: true })).error).toBeUndefined();
          const restored = await info(c, sid);
          expect(restored.compaction).toMatchObject({ v: 2 });
          expect('recovery' in restored).toBe(false);
        }
      } finally { c.close(); }
    });
  }

  it('E1 首次请求超窗、压缩后同模型继续：事件、审计三类、chat.contextInfo、run 终态与会话绑定', async () => {
    const { c, sid, binding } = await scenario();
    const before = (await c.call('chat.messages.list', { sessionId: sid })).result as RawMessage[];
    expect((await c.call('chat.prompt', { sessionId: sid, text: 'hello' })).error).toBeUndefined();
    await waitFor('回合结束', () => ended(c, sid));

    const events = eventsOf(c, sid);
    expect(hits.map(h => `${h.kind}:${h.status}`)).toEqual(['main:400', 'summary:200', 'main:200']);
    expect(events.at(-1)).toMatchObject({ kind: 'turnEnd' });
    expect(events.some(e => e.kind === 'fallback')).toBe(false);
    const rec = events.filter(e => e.kind === 'contextRecovery').map(e => e.view as Body);
    expect(rec.map(v => v.phase)).toEqual(['resending', 'recovered']);
    const compacted = events.filter(e => e.kind === 'compacted');
    expect(compacted).toHaveLength(1);
    expect(compacted[0].detail).toMatchObject({ v: 2, trigger: 'overflow', form: 'structured' });
    // 重发的请求：摘要消息 + 最近的原文，以用户刚发的那条结尾
    const resent = (hits[2].body.messages as Body[]).filter(m => m.role !== 'system');
    expect(String(resent[0].content).startsWith('[对话摘要] ')).toBe(true);
    expect(resent.at(-1)).toMatchObject({ role: 'user', content: 'hello' });

    // 会话绑定不变；原历史不变（只多了这条用户消息与回复）
    expect((await c.call('chat.sessions.list')).result.find((x: { id: string }) => x.id === sid)?.modelBinding).toBe(binding);
    const after = (await c.call('chat.messages.list', { sessionId: sid })).result as RawMessage[];
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after).toHaveLength(before.length + 2);

    // 审计：压缩（带前后预算，不带摘要正文）与恢复
    await waitFor('context.compacted 审计', async () => (await audits(c, sid, 'context.compacted')).length === 1);
    const [comp] = await audits(c, sid, 'context.compacted');
    expect(comp).toMatchObject({ markerId: compacted[0].markerId, trigger: 'overflow', rule: 'recent-turns' });
    expect(comp.before.inputTokens).toBeGreaterThan(comp.after.inputTokens);
    expect(JSON.stringify(comp)).not.toContain('【目标】');
    expect(JSON.stringify(comp)).not.toContain('question 1');
    const recovery = await audits(c, sid, 'context.recovery');
    expect(recovery).toHaveLength(1);
    expect(recovery[0]).toMatchObject({ phase: 'recovered', resends: 1 });
    expect('interrupted' in recovery[0]).toBe(false);
    expect(await audits(c, sid, 'context.compactFailed')).toEqual([]);

    // chat.contextInfo：压缩记录的摘录来自库；最近一次恢复的终态留到下一次 chat.prompt
    const ci = await info(c, sid);
    expect(ci.compaction).toMatchObject({ markerId: compacted[0].markerId, v: 2, trigger: 'overflow' });
    expect(ci.recovery).toMatchObject({ phase: 'recovered', incident: rec[0].incident });
    // run 终态与工具账本：这次运行没有工具调用，账本里也没有执行行（恢复不重放任何东西）
    const snap = (await c.call('chat.runs.snapshot', { sessionId: sid })).result as { runs: Body[]; executions: Body[] };
    expect(snap.runs.at(-1)).toMatchObject({ state: 'completed' });
    expect(snap.executions).toEqual([]);
    c.close();
  });

  it('E3 重发没有完成（取消）：运行结束后 chat.contextInfo 不再报「正在重发」，审计记一条带 interrupted 的恢复', async () => {
    const { c, sid } = await scenario();
    accepted = 'hold'; held = { arrived: gate(), release: gate() };
    expect((await c.call('chat.prompt', { sessionId: sid, text: 'hello' })).error).toBeUndefined();
    await held.arrived.wait;
    // 重发的流挂着：此刻上下文条报的是「正在重发」
    expect((await info(c, sid)).recovery).toMatchObject({ phase: 'resending' });
    await c.call('chat.cancel', { sessionId: sid });
    await waitFor('回合结束', () => ended(c, sid));
    held.release.open();
    await waitFor('run 收尾', async () => !(await info(c, sid)).live && (await audits(c, sid, 'context.recovery')).length === 1);

    expect(eventsOf(c, sid).at(-1)).toMatchObject({ kind: 'error', message: '已取消' });
    expect('recovery' in await info(c, sid)).toBe(false);
    const [row] = await audits(c, sid, 'context.recovery');
    expect(row).toMatchObject({ phase: 'resending', interrupted: true });
    const snap = (await c.call('chat.runs.snapshot', { sessionId: sid })).result as { runs: Body[] };
    expect(snap.runs.at(-1)).toMatchObject({ state: 'cancelled' });
    // 恢复里写下的 marker 是完整有效的，保留
    expect((await info(c, sid)).compaction).toMatchObject({ v: 2, trigger: 'overflow' });
    c.close();
  });

  it('E3 重发没有完成（重发的流回 401、没有备用）：同样不留「正在重发」，run 记为失败', async () => {
    const { c, sid } = await scenario();
    accepted = 'unauthorized';
    expect((await c.call('chat.prompt', { sessionId: sid, text: 'hello' })).error).toBeUndefined();
    await waitFor('回合结束', () => ended(c, sid));
    await waitFor('run 收尾', async () => (await audits(c, sid, 'context.recovery')).length === 1);

    expect(hits.map(h => `${h.kind}:${h.status}`)).toEqual(['main:400', 'summary:200', 'main:401']);
    expect(eventsOf(c, sid).at(-1)).toMatchObject({ kind: 'error' });
    expect(eventsOf(c, sid).filter(e => e.kind === 'contextRecovery').map(e => (e.view as Body).phase)).toEqual(['resending']);
    expect('recovery' in await info(c, sid)).toBe(false);
    expect((await audits(c, sid, 'context.recovery'))[0]).toMatchObject({ phase: 'resending', interrupted: true });
    const snap = (await c.call('chat.runs.snapshot', { sessionId: sid })).result as { runs: Body[] };
    expect(snap.runs.at(-1)).toMatchObject({ state: 'failed' });
    c.close();
  });

  it('E2 重启：marker 已写入、重发的流还挂着时关停引擎，同一数据根再启动后发下一条消息——新运行的第一个请求体带摘要与程序记录，原历史不变，重启前执行过的工具没有被再执行', async () => {
    const first = await scenario({ seed: false });
    const { sid, binding } = first;
    const dataDir = first.srv.dataDir;
    const hitKinds = (): string[] => hits.map(h => `${h.kind}:${h.status}`);
    const rowsOf = (table: 'compact_markers' | 'compact_marker_meta'): Body[] => readRows(dataDir, `SELECT * FROM ${table} WHERE session_id=? ORDER BY created_at, rowid`, sid);
    const messageRows = (): Body[] => readRows(dataDir, 'SELECT id, role, parts_json, created_at FROM messages WHERE session_id=? ORDER BY created_at, id', sid);
    const execRows = (): Body[] => readRows(dataDir, 'SELECT * FROM tool_executions WHERE session_id=? ORDER BY batch, call_index', sid);
    const runRows = (): Body[] => readRows(dataDir, 'SELECT state, stop_reason, active FROM agent_runs WHERE session_id=? ORDER BY generation', sid);

    // 第一轮：真的 file_read 执行一次（工作区里的 notes.txt），工具账本落一行
    const workspace = new MinisPaths(dataDir).workspaceOf(sid);
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, 'notes.txt'), 'NOTES-KEY-7919\n', 'utf8');
    accepted = 'tool-once';
    expect((await first.c.call('chat.prompt', { sessionId: sid, text: 'read notes.txt' })).error).toBeUndefined();
    await waitFor('第一轮结束', () => ended(first.c, sid));
    expect(hitKinds()).toEqual(['main:200', 'main:200']);
    expect(JSON.stringify(hits[1].body.messages)).toContain('NOTES-KEY-7919');
    const execs = execRows();
    expect(execs).toMatchObject([{ tool_use_id: 'call_read_notes', tool_name: 'file_read' }]);

    // 落 8 组长问答，等时钟越过它们（下一条用户消息的时间戳要排在后面），再发一条：超窗 → 压缩写下 marker → 重发的流挂在闸门上
    const last = seedLongHistory(dataDir, sid, true);
    await waitFor('时钟越过落库的历史', () => Date.now() / 1000 > last + 0.001);
    hits.length = 0;
    accepted = 'hold'; held = { arrived: gate(), release: gate() };
    expect((await first.c.call('chat.prompt', { sessionId: sid, text: 'hello' })).error).toBeUndefined();
    await held.arrived.wait;
    expect(hitKinds()).toEqual(['main:400', 'summary:200', 'main:200']);
    expect((await info(first.c, sid)).recovery).toMatchObject({ phase: 'resending' });
    const markersBefore = rowsOf('compact_markers'); const metaBefore = rowsOf('compact_marker_meta');
    expect(markersBefore).toHaveLength(1);
    expect(metaBefore).toMatchObject([{ marker_id: markersBefore[0].id, v: 2 }]);
    const messagesBefore = messageRows();
    expect(messagesBefore).toHaveLength(4 + 16 + 1);

    // 关停：有序关停会中止那次还挂着的重发，run 记为 cancelled / shutdown（F05）；之后才放行假端点
    await first.srv.close();
    held.release.open(); held = undefined;
    first.c.close();
    expect(runRows()).toMatchObject([{ state: 'completed', active: null }, { state: 'cancelled', stop_reason: 'shutdown', active: null }]);
    expect(messageRows()).toEqual(messagesBefore);
    expect(rowsOf('compact_markers')).toEqual(markersBefore);

    // 同一数据根再启动
    hits.length = 0; accepted = 'ok';
    const again = await boot(dataDir);
    const c2 = rpcClient(again.port, again.authToken); await c2.ready;
    // 压缩记录的摘录来自库，重启后仍在；恢复状态只在内存里，重启后没有；那次没完成的重发在审计里记着 interrupted
    const ci = await info(c2, sid);
    expect(ci.compaction).toMatchObject({ markerId: markersBefore[0].id, v: 2, trigger: 'overflow' });
    expect('recovery' in ci).toBe(false);
    expect(await audits(c2, sid, 'context.recovery')).toMatchObject([{ phase: 'resending', interrupted: true }]);
    expect((await c2.call('chat.sessions.list')).result.find((x: { id: string }) => x.id === sid)?.modelBinding).toBe(binding);

    expect((await c2.call('chat.prompt', { sessionId: sid, text: 'next question' })).error).toBeUndefined();
    await waitFor('新运行结束', () => ended(c2, sid));
    expect(eventsOf(c2, sid).at(-1)).toMatchObject({ kind: 'turnEnd' });
    // 新运行从落库历史与最新 marker 重建：只发了一个请求（没有再被拒、没有再摘要），以摘要消息开头、带程序记录
    expect(hitKinds()).toEqual(['main:200']);
    const sent = (hits[0].body.messages as Body[]).filter(m => m.role !== 'system');
    const head = String(sent[0].content);
    expect(head.startsWith('[对话摘要] ')).toBe(true);
    expect(head).toContain('【程序记录】');
    // 程序记录里有被摘走的第一条用户指示的原话；锚点之后的原文（没完成的那一轮的 hello）与新消息都在
    expect(head).toContain('1. read notes.txt');
    expect(sent.filter(m => m.role === 'user').map(m => m.content).slice(-2)).toEqual(['hello', 'next question']);
    // 重启前那次 file_read 的调用与结果已在摘要覆盖范围内：请求体里没有它，也没有因此再发一次调用
    expect(sent.some(m => m.role === 'tool' || (m.tool_calls as unknown[] | undefined)?.length)).toBe(false);

    // 原历史不变：重启前的消息逐行相同，只多了这条用户消息与回复；marker 与 meta 的行不变
    const messagesAfter = messageRows();
    expect(messagesAfter.slice(0, messagesBefore.length)).toEqual(messagesBefore);
    expect(messagesAfter).toHaveLength(messagesBefore.length + 2);
    expect(rowsOf('compact_markers')).toEqual(markersBefore);
    expect(rowsOf('compact_marker_meta')).toEqual(metaBefore);
    // 工具账本：重启前执行过的那一次仍只有那一行（逐字段相同），恢复、重启与新运行都没有重放它；历史里的 toolUse 也只有那一条
    expect(execRows()).toEqual(execs);
    expect(messagesAfter.filter(r => String(r.parts_json).includes('"toolUse"'))).toHaveLength(1);
    expect(runRows()).toMatchObject([{ state: 'completed' }, { state: 'cancelled', stop_reason: 'shutdown' }, { state: 'completed', active: null }]);
    c2.close();
  }, 60000);
});
