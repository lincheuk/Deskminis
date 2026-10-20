import { requestToolOutput } from './request-tool-output-fixture';
/**
 * F02 端到端（验收 4 / 5）：真 minisd（startMinisd）+ JSON-RPC + 本地假端点。
 * 上下文条（chat.contextInfo）、最终请求（抓到的请求体）、落库的 usage 用的是同一个预算；预算不足有可解释的错误；
 * 旧 TokenUsage 记录读取兼容；费用只在当前端点自己有价格时估算。
 * 受控时序用闸门：假端点在指定路径上挂住请求，测试放行；等事件用条件轮询（与 runtime-model-e2e 相同）。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMinisd } from '../src/minisd/index';
import { ModelCatalog } from '../src/minisd/providers/model-catalog';
import { openDb } from '../src/minisd/store/db';
import { ChatStore } from '../src/minisd/store/chat-store';
import { calibrationFrom } from '../src/minisd/agent/request-budget';
import { describeUsage } from '../src/shared/usage';
import { estimateTextTokens } from '../src/shared/token-estimate';
import type { ContextInfo, RequestBudget } from '../src/shared/request-budget';
import type { ContentPart, RawMessage } from '../src/shared/types';
import { catalogFixtureF02, jsonResponse } from './runtime-model-fixture';
import { pngBytes } from './image-fixtures';

function gate() { let open!: () => void; const wait = new Promise<void>(r => { open = r; }); return { wait, open }; }
type Body = Record<string, any>;

let mock: Server;
let mockPort = 0;
const hits: { url: string; body: Body }[] = [];
/** 挂住请求的闸门：路径里带 /hold-<key>/ 且该 key 已布防时，请求到达后等测试放行。放行后撤防，后续请求直接通过。 */
const holds = new Map<string, { arrived: ReturnType<typeof gate>; release: ReturnType<typeof gate> }>();
function arm(key: string) { const h = { arrived: gate(), release: gate() }; holds.set(key, h); return h; }
/** /usage/ 路径上末帧带的 usage：缓存命中 800、推理 120（都是总数的子集）。 */
const USAGE = { prompt_tokens: 1_000, completion_tokens: 300, total_tokens: 1_300, prompt_tokens_details: { cached_tokens: 800 }, completion_tokens_details: { reasoning_tokens: 120 } };
/** /toolonce/ 路径：调工具那次回复带的长正文（约 38,000 token），与摘要请求的回复。 */
const TOOLONCE_TEXT = `working notes: ${'lorem ipsum dolor sit amet '.repeat(5_630)}`.slice(0, 152_000);
const TOOLONCE_SUMMARY = 'Summary: the user asked four long questions about the build log; the first two were answered in full.';

beforeAll(async () => {
  mock = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => void (async () => {
      const url = String(req.url);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Body;
      hits.push({ url, body });
      const key = /\/hold-([a-z0-9]+)\//.exec(url)?.[1];
      const h = key ? holds.get(key) : undefined;
      if (key && h) { h.arrived.open(); await h.release.wait; holds.delete(key); }
      if (url.includes('/fail/')) {
        // 限流：造一次真正的故障降级（F02b 的「按输出额度换槽之后接手的成员又故障」）
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'rate limited (mock)' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (url.endsWith('/v1/messages')) {
        // Anthropic 形状
        const frames: Body[] = [
          { type: 'message_start', message: { usage: { input_tokens: 1_500, output_tokens: 1 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'a picture' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
          { type: 'message_stop' },
        ];
        res.end(frames.map(f => `event: ${String(f.type)}\ndata: ${JSON.stringify(f)}\n\n`).join(''));
        return;
      }
      if (url.includes('/reasononly/')) {
        // 只有推理、没有正文与工具调用、以 length 收尾：推理把输出额度用完了
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: 'thinking it through ' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] })}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }
      if (url.includes('/empty/')) {
        // 真正的空响应：正常收尾，没有正文也没有工具调用（F02b 终审：按输出额度换过去的成员自己出了故障）
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }
      if (url.includes('/summary/') && body.messages?.[0]?.role === 'system' && body.messages[0].content === '你是对话摘要助手。') {
        // 摘要请求回一段认得出来的摘要；其余请求落到下面的「ok」
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: TOOLONCE_SUMMARY } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }
      if (url.includes('/toolonce/')) {
        // 接手之后还要干活的备用（F02b 复审 R2）：摘要请求回一段摘要；请求里还没有工具结果时回一段长正文加一次工具调用
        // （对话因此涨一截）；之后落到下面的「ok」
        const msgs = (body.messages ?? []) as Body[];
        if (msgs[0]?.role === 'system' && msgs[0].content === '你是对话摘要助手。') {
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: TOOLONCE_SUMMARY } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
          res.end('data: [DONE]\n\n');
          return;
        }
        if (!msgs.some(m => m.role === 'tool')) {
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: TOOLONCE_TEXT } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_toolonce', function: { name: 'no_such_tool', arguments: '{"tool_title":"t"}' } }] } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
          res.end('data: [DONE]\n\n');
          return;
        }
      }
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      if (url.includes('/usage/')) res.write(`data: ${JSON.stringify({ choices: [], usage: USAGE })}\n\n`);
      res.end('data: [DONE]\n\n');
    })());
  });
  await new Promise<void>(r => mock.listen(0, '127.0.0.1', () => r()));
  mockPort = (mock.address() as { port: number }).port;
  // 回环地址不参与目录 api 匹配：夹具里的「服务商 api」用保留域名，这里只把它改写回本地假端点（请求仍是真 HTTP）
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: unknown, init?: unknown) =>
    realFetch(typeof input === 'string' ? input.replace(`http://${MOCK_HOST}:${mockPort}/`, `http://127.0.0.1:${mockPort}/`) : input as never, init as never));
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await new Promise<void>(r => mock.close(() => r()));
});

const MOCK_HOST = 'f02-mock.test';
const base = (path: string) => `http://${MOCK_HOST}:${mockPort}/${path}`;
/** 目录收录的服务商（vendor-a）的 api 地址；suffix 接在后面仍属于它（按路径段前缀匹配）。 */
const vendorA = (suffix = '') => base(`vendor-a/v1${suffix}`);
/** 不匹配任何目录 api 的中转地址。 */
const relay = (prefix = '') => base(`relay/${prefix}v1`);

let stop: (() => Promise<void>) | undefined;
const savedFake = process.env.DESKMINIS_FAKE_PROVIDER;
afterEach(async () => {
  // 没放行的闸门全部放开，别让假端点的连接挂到下一条用例
  for (const h of holds.values()) h.release.open();
  holds.clear();
  await stop?.(); stop = undefined;
  if (savedFake === undefined) delete process.env.DESKMINIS_FAKE_PROVIDER; else process.env.DESKMINIS_FAKE_PROVIDER = savedFake;
});

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'dm-f02-'));
  const seed = new ModelCatalog(join(dir, 'models-dev-cache.json'), async () => jsonResponse(catalogFixtureF02(
    { vendorA: vendorA(), vendorB: base('vendor-b/v1'), tie: base('tie/v1'), loopback: `http://127.0.0.1:${mockPort}/loop/v1` }, base('plan/v1'))));
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

async function waitFor(what: string, cond: () => boolean, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise(r => setTimeout(r, 10));
  }
}
const eventsOf = (c: Client, sessionId: string, from = 0): Body[] =>
  c.notifications.slice(from).filter(n => n.method === 'chat.event' && n.params?.sessionId === sessionId).map(n => n.params.event as Body);
const ended = (c: Client, sessionId: string, from = 0): boolean => eventsOf(c, sessionId, from).some(e => e.kind === 'turnEnd' || e.kind === 'error');

const create = async (c: Client, name: string, baseUrl: string, modelId: string, extra: Body = {}): Promise<{ id: string }> =>
  (await c.call('provider.instances.create', { name, kind: 'openai-compat', baseUrl, modelId, apiKey: 'test-key', ...extra })).result;
/** 建会话并先改名（自动命名只在默认标题时动手，它的请求会混进假端点的记录），再绑定。 */
async function session(c: Client, binding: string): Promise<string> {
  const s = (await c.call('chat.sessions.create', {})).result;
  await c.call('chat.sessions.rename', { sessionId: s.id, title: 'F02 会话' });
  await c.call('chat.sessions.setModelBinding', { sessionId: s.id, binding });
  return s.id;
}
const info = async (c: Client, sessionId: string): Promise<ContextInfo> => {
  const r = await c.call('chat.contextInfo', { sessionId });
  expect(r.error).toBeUndefined();
  return r.result as ContextInfo;
};
const messages = async (c: Client, sessionId: string): Promise<RawMessage[]> => (await c.call('chat.messages.list', { sessionId })).result as RawMessage[];
const bindingOf = async (c: Client, sessionId: string): Promise<string | undefined> =>
  (await c.call('chat.sessions.list')).result.find((x: { id: string }) => x.id === sessionId)?.modelBinding;
/** 发一条消息并等回合结束，返回这一回合的事件与假端点收到的请求。 */
async function turn(c: Client, params: Body) {
  const mark = c.notifications.length;
  const before = hits.length;
  const r = await c.call('chat.prompt', params);
  if (r.error) return { error: r.error.message as string, events: [] as Body[], requests: hits.slice(before) };
  await waitFor('回合结束', () => ended(c, params.sessionId, mark));
  return { error: undefined, events: eventsOf(c, params.sessionId, mark), requests: hits.slice(before) };
}
/** 发一条消息，等假端点收到请求并挂住；返回放行并等回合结束的函数。 */
async function heldTurn(c: Client, key: string, params: Body) {
  const h = arm(key);
  const mark = c.notifications.length;
  const before = hits.length;
  const r = await c.call('chat.prompt', params);
  expect(r.error).toBeUndefined();
  await h.arrived.wait;
  return {
    request: hits.slice(before).at(-1)!,
    finish: async (): Promise<Body[]> => { h.release.open(); await waitFor('回合结束', () => ended(c, params.sessionId, mark)); return eventsOf(c, params.sessionId, mark); },
    events: (): Body[] => eventsOf(c, params.sessionId, mark),
  };
}

describe('F02 端到端：上下文条、最终请求、落库 usage 用同一个预算', () => {
  it('E1 / E2 运行中的上下文条就是写进 max_tokens 的那个预算；空闲时用同一个函数推算下一次请求', async () => {
    const srv = await boot();
    const c = rpcClient(srv.port, srv.authToken); await c.ready;
    const inst = await create(c, '中转', relay('hold-e1/'), 'unlisted-model', { contextWindow: 64_000 });
    const sid = await session(c, `provider:${inst.id}`);

    // E1：请求挂住时读上下文条。带一个任务偏好，让这次的 max_tokens（3000）不等于模型上限（8192）：
    // 请求体若仍按上限发，这里对不上
    const first = await heldTurn(c, 'e1', { sessionId: sid, text: 'hello', maxOutputTokens: 3_000 });
    const live = await info(c, sid);
    expect(live.live).toBe(true);
    expect(live.windowTokens).toBe(64_000);
    expect(first.request.body.max_tokens).toBe(3_000);
    expect(live.budget!.output.cap).toBe(8_192);
    expect(live.budget!.output.requested).toBe(first.request.body.max_tokens);
    expect(live.usedTokens).toBe(live.budget!.input.tokens);
    expect(live.remaining).toBe(64_000 - live.usedTokens);
    expect(live.budget!.limits).toMatchObject({ kind: 'shared', inputLimit: 64_000, authority: 'manual' });
    expect((await first.finish()).at(-1)).toMatchObject({ kind: 'turnEnd' });

    // E2：回合结束后是按落库状态推算的下一次请求
    const idle = await info(c, sid);
    expect(idle.live).toBe(false);
    expect(idle.budget!.input.components.system).toBeGreaterThan(0);
    expect(idle.budget!.input.components.tools).toBeGreaterThan(0);
    expect(idle.usedTokens).toBe(idle.budget!.input.tokens);
    // 再发一条一个字的消息并挂住：运行中的预算与刚才空闲时的推算，固定部分相等，对话部分只差这条新消息
    const second = await heldTurn(c, 'e1', { sessionId: sid, text: 'x' });
    const busy = await info(c, sid);
    expect(busy.live).toBe(true);
    expect(busy.budget!.input.components.system).toBe(idle.budget!.input.components.system);
    expect(busy.budget!.input.components.tools).toBe(idle.budget!.input.components.tools);
    expect(busy.budget!.input.toolCount).toBe(idle.budget!.input.toolCount);
    const delta = busy.budget!.input.components.history - idle.budget!.input.components.history;
    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeLessThanOrEqual(64);
    expect(busy.budget!.output.requested).toBe(second.request.body.max_tokens);
    // 请求体里的工具数与系统提示就是预算量的那一份
    expect((second.request.body.tools as unknown[]).length).toBe(busy.budget!.input.toolCount);
    await second.finish();
    c.close();
  }, 60000);

  it('E3 旧 TokenUsage 记录读取兼容：原样返回、不让上下文条报错、不当新口径用', async () => {
    const srv = await boot();
    const c = rpcClient(srv.port, srv.authToken); await c.ready;
    const inst = await create(c, '中转', relay(), 'unlisted-model', { contextWindow: 64_000 });
    const sid = await session(c, `provider:${inst.id}`);
    await turn(c, { sessionId: sid, text: 'hello' });
    await turn(c, { sessionId: sid, text: 'again' });
    // 用 SQL 把两条 assistant 消息的 token_usage 改成 F02 之前的形状：{N, M} 与没收到 usage 时落的 0/0
    const db = openDb(join(srv.dataDir, 'minis.db'));
    try {
      const ids = (await messages(c, sid)).filter(m => m.role === 'assistant').map(m => m.id);
      expect(ids).toHaveLength(2);
      const set = db.prepare('UPDATE messages SET token_usage = ? WHERE id = ?');
      set.run('{"inputTokens":10,"outputTokens":25}', ids[0]);
      set.run('{"inputTokens":0,"outputTokens":0}', ids[1]);
    } finally { db.close(); }
    const list = (await messages(c, sid)).filter(m => m.role === 'assistant');
    expect(list.map(m => m.tokenUsage)).toEqual([{ inputTokens: 10, outputTokens: 25 }, { inputTokens: 0, outputTokens: 0 }]);
    const ctx = await info(c, sid);
    expect(ctx.budget!.input.calibration).toEqual({ ratio: 1, calibrated: false });
    expect(describeUsage(list[0].tokenUsage)).toMatchObject({ legacy: true, total: 35, input: 10, output: 25, cost: { status: 'unknown', reason: 'legacy' } });
    expect(describeUsage(list[1].tokenUsage)).toMatchObject({ legacy: true, unreported: ['input', 'output'], cost: { status: 'unknown', reason: 'no-usage' } });
    // 旧记录不参与校准，也不计入实测上限
    expect(calibrationFrom(await messages(c, sid), { protocol: 'openai-chat', modelId: 'unlisted-model' })).toEqual({ ratio: 1, calibrated: false });
    c.close();
  }, 60000);

  it('E4 真实系统提示与内置工具放不下手动窗口：报 requestBudget 并带预算，端点 0 请求，用户消息已落库，绑定不变', async () => {
    const srv = await boot();
    const c = rpcClient(srv.port, srv.authToken); await c.ready;
    const inst = await create(c, '中转', relay(), 'unlisted-model', { contextWindow: 64_000 });
    const sid = await session(c, `provider:${inst.id}`);
    const before = await info(c, sid);
    const fixed = before.budget!.input.components.system + before.budget!.input.components.tools;
    expect(fixed).toBeGreaterThan(1_000);
    // 把窗口手动改成固定开销的一半：连估算下界（× 0.7）都放不下
    expect((await c.call('provider.instances.update', { id: inst.id, contextWindow: Math.floor(fixed / 2) })).error).toBeUndefined();
    expect((await info(c, sid)).budget!.status).toBe('blocked');
    const t = await turn(c, { sessionId: sid, text: 'hello' });
    expect(t.error).toBeUndefined();
    expect(t.requests).toHaveLength(0);
    const err = t.events.at(-1)!;
    expect(err).toMatchObject({ kind: 'error', code: 'requestBudget' });
    expect((err.budget as RequestBudget).status).toBe('blocked');
    expect(err.message).toContain('系统提示约');
    expect(err.message).toContain('本轮没有发送给任何模型');
    expect('relayDraft' in err).toBe(false);
    const list = await messages(c, sid);
    expect(list.map(m => m.role)).toEqual(['user']);
    expect(await bindingOf(c, sid)).toBe(`provider:${inst.id}`);
    c.close();
  }, 60000);

  it('E5 模型组首成员放不下固定开销、次成员接手：不是故障，会话仍绑定模型组', async () => {
    const srv = await boot();
    const c = rpcClient(srv.port, srv.authToken); await c.ready;
    const big = await create(c, '大窗口', relay(), 'unlisted-model', { contextWindow: 200_000 });
    const probe = await info(c, await session(c, `provider:${big.id}`));
    const fixed = probe.budget!.input.components.system + probe.budget!.input.components.tools;
    const small = await create(c, '小窗口', relay('small/'), 'unlisted-model', { contextWindow: Math.floor(fixed / 2) });
    const g = (await c.call('modelgroup.create', { name: '小先', memberIds: [small.id, big.id] })).result;
    const sid = await session(c, `group:${g.id}`);
    const t = await turn(c, { sessionId: sid, text: 'hello' });
    expect(t.requests.map(r => r.url)).toEqual(['/relay/v1/chat/completions']);
    expect(t.events.find(e => e.kind === 'fallback')).toMatchObject({ from: '小窗口(unlisted-model)', to: '大窗口(unlisted-model)', cause: 'requestBudget' });
    expect(t.events.at(-1)).toMatchObject({ kind: 'turnEnd' });
    expect(await bindingOf(c, sid)).toBe(`group:${g.id}`);
    c.close();
  }, 60000);

  it('E6 费用按当次端点自己的价格估算：收录端点有价格 → 估算且金额对得上；同名型号经中转 → 未知（不借用别家的价格）', async () => {
    const srv = await boot();
    const c = rpcClient(srv.port, srv.authToken); await c.ready;
    const own = await create(c, '收录端点', vendorA('/usage'), 'ind-model');
    const viaRelay = await create(c, '中转', relay('usage/'), 'ind-model');
    const s1 = await session(c, `provider:${own.id}`);
    const s2 = await session(c, `provider:${viaRelay.id}`);
    expect((await turn(c, { sessionId: s1, text: 'hello' })).events.at(-1)).toMatchObject({ kind: 'turnEnd' });
    expect((await turn(c, { sessionId: s2, text: 'hello' })).events.at(-1)).toMatchObject({ kind: 'turnEnd' });
    const u1 = (await messages(c, s1)).find(m => m.role === 'assistant')!.tokenUsage!;
    const u2 = (await messages(c, s2)).find(m => m.role === 'assistant')!.tokenUsage!;
    // 归一化：缓存与推理是总数的子集
    expect(u1).toMatchObject({ inputTokens: 1_000, outputTokens: 300, cacheReadTokens: 800, reasoningTokens: 120, v: 2 });
    expect(u1.source).toMatchObject({ by: 'provider', protocol: 'openai-chat', modelId: 'ind-model', instanceId: own.id });
    // 输入 1.25、输出 10、缓存读取 0.125（每百万 token）：(200 × 1.25 + 800 × 0.125 + 300 × 10) ÷ 1e6
    expect(u1.cost).toEqual({ status: 'estimated', usd: 0.00335 });
    expect(u2).toMatchObject({ inputTokens: 1_000, outputTokens: 300, cacheReadTokens: 800, reasoningTokens: 120 });
    expect(u2.cost).toEqual({ status: 'unknown', reason: 'no-price' });
    c.close();
  }, 60000);

  it('E7 chat.prompt 的 maxOutputTokens：进到请求体（低于 1,024 也照它发）；不是正整数当场报错、不落用户消息', async () => {
    const srv = await boot();
    const c = rpcClient(srv.port, srv.authToken); await c.ready;
    const inst = await create(c, '收录端点', vendorA(), 'ind-model');
    const sid = await session(c, `provider:${inst.id}`);
    const a = await turn(c, { sessionId: sid, text: 'one', maxOutputTokens: 2_000 });
    expect(a.requests[0].body.max_tokens).toBe(2_000);
    const b = await turn(c, { sessionId: sid, text: 'two', maxOutputTokens: 300 });
    expect(b.requests[0].body.max_tokens).toBe(300);
    // 不带偏好：默认额度
    const d = await turn(c, { sessionId: sid, text: 'three' });
    expect(d.requests[0].body.max_tokens).toBe(65_536);
    const count = (await messages(c, sid)).length;
    for (const bad of [0, -5, 1.5, '2000']) {
      const r = await turn(c, { sessionId: sid, text: 'bad', maxOutputTokens: bad });
      expect(r.error, String(bad)).toContain('maxOutputTokens 必须是正整数');
      expect(r.requests, String(bad)).toHaveLength(0);
    }
    expect((await messages(c, sid)).length).toBe(count);
    c.close();
  }, 60000);

  it('E8 / E9 两个会话同时运行各看各的预算；取消后上下文条回到空闲推算', async () => {
    const srv = await boot();
    const c = rpcClient(srv.port, srv.authToken); await c.ready;
    const ia = await create(c, '甲', relay('hold-e9a/'), 'unlisted-model', { contextWindow: 64_000 });
    const ib = await create(c, '乙', relay('hold-e9b/'), 'unlisted-model', { contextWindow: 64_000 });
    const sa = await session(c, `provider:${ia.id}`);
    const sb = await session(c, `provider:${ib.id}`);
    const ta = await heldTurn(c, 'e9a', { sessionId: sa, text: 'from A', maxOutputTokens: 1_111 });
    const tb = await heldTurn(c, 'e9b', { sessionId: sb, text: 'from B', maxOutputTokens: 2_222 });
    const [la, lb] = [await info(c, sa), await info(c, sb)];
    expect(la.live).toBe(true);
    expect(lb.live).toBe(true);
    expect(la.budget!.output.requested).toBe(1_111);
    expect(lb.budget!.output.requested).toBe(2_222);
    expect(la.budget!.slot.label).toBe('甲(unlisted-model)');
    expect(lb.budget!.slot.label).toBe('乙(unlisted-model)');
    // E8：取消 A（请求还挂着）
    await c.call('chat.cancel', { sessionId: sa });
    await waitFor('A 取消收尾', () => ended(c, sa));
    expect(ta.events().at(-1)).toEqual({ kind: 'error', message: '已取消' });
    const after = await info(c, sa);
    expect(after.live).toBe(false);
    expect(after.budget!.output.preferenceSource).toBe('default');
    // B 不受影响
    expect((await info(c, sb)).live).toBe(true);
    expect((await tb.finish()).at(-1)).toMatchObject({ kind: 'turnEnd' });
    expect((await info(c, sb)).live).toBe(false);
    c.close();
  }, 60000);

  it('E10 带图会话：运行中（整张图）与空闲时（只读文件头）量出同一个图片 token 数', async () => {
    const srv = await boot();
    const c = rpcClient(srv.port, srv.authToken); await c.ready;
    const inst = (await c.call('provider.instances.create', {
      name: 'Claude 中转', kind: 'anthropic', baseUrl: base('claude/hold-e10'), modelId: 'claude-relay', apiKey: 'test-key', contextWindow: 200_000,
      capabilityOverrides: { imageInput: true },
    })).result as { id: string };
    const sid = await session(c, `provider:${inst.id}`);
    const png = pngBytes(1000, 1000, 300_000);
    const dir = join(srv.dataDir, 'sessions', sid, 'attachments');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'shot.png'), png);
    const held = await heldTurn(c, 'e10', { sessionId: sid, text: 'what is this', attachments: ['attachments/shot.png'] });
    const busy = await info(c, sid);
    // 请求体里是整张图
    const image = (held.request.body.messages[0].content as Body[]).find(b => b.type === 'image')!;
    expect(image.source.data.length).toBe(400_000);
    expect((await held.finish()).at(-1)).toMatchObject({ kind: 'turnEnd' });
    const idle = await info(c, sid);
    expect(busy.live).toBe(true);
    expect(idle.live).toBe(false);
    for (const [name, x] of [['busy', busy], ['idle', idle]] as const) {
      // Anthropic 的 28 px 网格：1000×1000 → 36 × 36
      expect(x.budget!.input.components.media, name).toBe(1_296);
      expect(x.budget!.input.mediaBasis, name).toBe('formula');
      expect(x.budget!.input.imageCount, name).toBe(1);
    }
    // base64 的长度（40 万字符）没有被当成文本
    expect(idle.budget!.input.components.history).toBeLessThan(1_000);
    expect((await messages(c, sid)).find(m => m.role === 'assistant')!.tokenUsage!.estimate!.media).toBe(1_296);
    c.close();
  }, 60000);

  it('E11 会被修剪的会话：空闲时的上下文条按修剪后的历史推算，与随后真正发出的请求是同一个预算（只差新消息）', async () => {
    const srv = await boot();
    const c = rpcClient(srv.port, srv.authToken); await c.ready;
    const inst = await create(c, '中转', relay('hold-e11/'), 'unlisted-model', { contextWindow: 200_000 });
    const sid = await session(c, `provider:${inst.id}`);
    // 用第二个连接落一段上一回合留下的历史：1 条用户消息 + 12 轮工具（前 7 轮结果各 19,000 字符）+ 收尾的一句回答
    const big = 'lorem ipsum dolor sit amet '.repeat(704).slice(0, 19_000);
    const db = openDb(join(srv.dataDir, 'minis.db'));
    try {
      const store = new ChatStore(db);
      // 时间戳放在一分钟前、逐条递增：随后真发的那条用户消息按当前时间落库，必须排在这段历史之后
      let at = store.nowEpoch() - 60;
      const add = (role: 'user' | 'assistant', parts: ContentPart[]) =>
        store.appendMessage({ id: store.newId(), sessionId: sid, role, parts, createdAt: (at += 0.01), streamInterruptCount: 0 });
      add('user', [{ type: 'text', value: 'run the twelve steps' }]);
      for (let i = 1; i <= 12; i++) {
        add('assistant', [{ type: 'toolUse', value: { toolUseId: `T${i}`, name: 'file_read', input: `{"path":"part-${i}.log","tool_title":"read"}` } }]);
        add('user', [{ type: 'toolResult', value: { toolUseId: `T${i}`, output: i <= 7 ? big : `part ${i} ok`, success: true, status: 'success' } }]);
      }
      add('assistant', [{ type: 'text', value: 'all twelve parts look fine' }]);
    } finally { db.close(); }
    expect(await messages(c, sid)).toHaveLength(26);

    // 窗口很大时不修剪：这是没修剪的完整输入
    const wide = await info(c, sid);
    expect(wide.budget!.status).toBe('ok');
    const unpruned = wide.usedTokens;
    expect(unpruned).toBeGreaterThan(7 * 4_750);
    // 把窗口手动改到刚好比它大一成多：不修剪的话余量不足（over），循环会先修剪再发
    const window = Math.round(unpruned * 1.12);
    expect((await c.call('provider.instances.update', { id: inst.id, contextWindow: window })).error).toBeUndefined();

    const idle = await info(c, sid);
    expect(idle.live).toBe(false);
    expect(idle.windowTokens).toBe(window);
    // 空闲推算已经按修剪后的历史算：7 条大结果都换成了桩，状态与 max_tokens 是修剪之后的
    expect(unpruned - idle.usedTokens).toBeGreaterThan(30_000);
    expect(idle.budget!.status).toBe('ok');
    expect(idle.budget!.output).toMatchObject({ requested: 8_192, limitedBy: 'model' });
    expect(idle.budget!.reason).toBeUndefined();

    // 随后真发一条并挂住：循环修剪的是同一批结果，运行中的预算与刚才的推算只差这条新消息
    const held = await heldTurn(c, 'e11', { sessionId: sid, text: 'x' });
    await waitFor('修剪事件', () => held.events().some(e => e.kind === 'pruned'));
    expect(held.events().filter(e => e.kind === 'pruned')).toEqual([{ kind: 'pruned', count: 7 }]);
    const outputs = (held.request.body.messages as Body[]).filter(m => m.role === 'tool').map(m => requestToolOutput(m.content));
    expect(outputs).toHaveLength(12);
    expect(outputs.filter(o => o.startsWith('[工具结果已修剪'))).toHaveLength(7);
    expect(outputs.filter(o => o === big)).toHaveLength(0);
    const busy = await info(c, sid);
    expect(busy.live).toBe(true);
    expect(busy.budget!.input.components.system).toBe(idle.budget!.input.components.system);
    expect(busy.budget!.input.components.tools).toBe(idle.budget!.input.components.tools);
    const delta = busy.budget!.input.components.history - idle.budget!.input.components.history;
    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeLessThanOrEqual(64);
    expect(busy.usedTokens - idle.usedTokens).toBe(delta);
    expect(busy.budget!.status).toBe(idle.budget!.status);
    expect(busy.budget!.output.requested).toBe(idle.budget!.output.requested);
    expect(held.request.body.max_tokens).toBe(idle.budget!.output.requested);
    expect((await held.finish()).at(-1)).toMatchObject({ kind: 'turnEnd' });
    c.close();
  }, 60000);

  it('E11b 目录给了独立输入上限的型号：空闲推算判修剪档用的分母是输入上限（272,000），不是窗口（400,000）——与循环同一个', async () => {
    const srv = await boot();
    const c = rpcClient(srv.port, srv.authToken); await c.ready;
    const inst = await create(c, '收录端点', vendorA('/hold-e11b'), 'ind-model');
    const sid = await session(c, `provider:${inst.id}`);
    // 同 E11 的历史形状，前 7 轮结果各 70,000 字符（约 17,500 token）。前提：这 7 条合计约 122,500，
    // 占输入上限 272,000 的四成以上（修剪档），却不到窗口 400,000 的四成（没到档）；预算本身不紧（输出另计，不随输入收紧）
    const big = 'lorem ipsum dolor sit amet '.repeat(2_593).slice(0, 70_000);
    const bigTokens = 7 * (big.length / 4);
    expect(bigTokens).toBeGreaterThan(0.4 * 272_000);
    expect(bigTokens + 10_000).toBeLessThan(0.4 * 400_000);
    const db = openDb(join(srv.dataDir, 'minis.db'));
    try {
      const store = new ChatStore(db);
      let at = store.nowEpoch() - 60;
      const add = (role: 'user' | 'assistant', parts: ContentPart[]) =>
        store.appendMessage({ id: store.newId(), sessionId: sid, role, parts, createdAt: (at += 0.01), streamInterruptCount: 0 });
      add('user', [{ type: 'text', value: 'run the twelve steps' }]);
      for (let i = 1; i <= 12; i++) {
        add('assistant', [{ type: 'toolUse', value: { toolUseId: `T${i}`, name: 'file_read', input: `{"path":"part-${i}.log","tool_title":"read"}` } }]);
        add('user', [{ type: 'toolResult', value: { toolUseId: `T${i}`, output: i <= 7 ? big : `part ${i} ok`, success: true, status: 'success' } }]);
      }
      add('assistant', [{ type: 'text', value: 'all twelve parts look fine' }]);
    } finally { db.close(); }
    expect(await messages(c, sid)).toHaveLength(26);

    const idle = await info(c, sid);
    expect(idle.live).toBe(false);
    expect(idle.windowTokens).toBe(400_000);
    expect(idle.budget!.limits).toMatchObject({ kind: 'separate', inputLimit: 272_000 });
    // 空闲推算已经按修剪后的历史算：7 条大结果换成了桩，对话只剩几千。按窗口判档的话这里是没修剪的十二万多
    expect(idle.budget!.input.components.history).toBeLessThan(5_000);
    expect(idle.usedTokens).toBeLessThan(20_000);
    expect(idle.budget!.status).toBe('ok');

    // 随后真发一条并挂住：循环按输入上限判到了修剪档，修剪的是同一批结果；运行中的预算与刚才的推算只差这条新消息
    const held = await heldTurn(c, 'e11b', { sessionId: sid, text: 'x' });
    await waitFor('修剪事件', () => held.events().some(e => e.kind === 'pruned'));
    expect(held.events().filter(e => e.kind === 'pruned')).toEqual([{ kind: 'pruned', count: 7 }]);
    const outputs = (held.request.body.messages as Body[]).filter(m => m.role === 'tool').map(m => requestToolOutput(m.content));
    expect(outputs).toHaveLength(12);
    expect(outputs.filter(o => o.startsWith('[工具结果已修剪'))).toHaveLength(7);
    const busy = await info(c, sid);
    expect(busy.live).toBe(true);
    expect(busy.budget!.limits).toMatchObject({ kind: 'separate', inputLimit: 272_000 });
    const delta = busy.budget!.input.components.history - idle.budget!.input.components.history;
    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeLessThanOrEqual(64);
    expect(busy.usedTokens - idle.usedTokens).toBe(delta);
    expect((await held.finish()).at(-1)).toMatchObject({ kind: 'turnEnd' });
    c.close();
  }, 60000);

  it('E12 生产接线的系统提示分段：Anthropic 请求的 system 两块，稳定段（人设与身份）带缓存断点、动态段（记忆）不带；预算分列与之一致', async () => {
    const srv = await boot();
    // 人设与全局记忆放在数据根的 memory 目录下（会话默认开着记忆）
    const mem = join(srv.dataDir, 'memory');
    mkdirSync(mem, { recursive: true });
    writeFileSync(join(mem, 'SOUL.md'), 'PERSONA-MARK you are a careful assistant.');
    writeFileSync(join(mem, 'GLOBAL.md'), `MEMORY-MARK the user prefers short answers. ${'remember this detail. '.repeat(60)}`);
    const c = rpcClient(srv.port, srv.authToken); await c.ready;
    const inst = (await c.call('provider.instances.create', {
      name: 'Claude 中转', kind: 'anthropic', baseUrl: base('claude/hold-e12'), modelId: 'claude-relay', apiKey: 'test-key', contextWindow: 200_000,
    })).result as { id: string };
    const sid = await session(c, `provider:${inst.id}`);
    const held = await heldTurn(c, 'e12', { sessionId: sid, text: 'hello' });
    const live = await info(c, sid);
    const system = held.request.body.system as Body[];
    expect(system).toHaveLength(2);
    // 第 1 块是稳定段：人设在最前、含身份段，带缓存断点，不含记忆
    expect(String(system[0].text).startsWith('PERSONA-MARK')).toBe(true);
    expect(system[0].text).toContain('你是 DeskMinis');
    expect(system[0].text).not.toContain('MEMORY-MARK');
    expect(system[0].cache_control).toEqual({ type: 'ephemeral' });
    // 第 2 块是动态段：记忆，不带断点（它每轮都可能变，断点打在它后面等于没有缓存）
    expect(String(system[1].text).startsWith('以下是背景上下文')).toBe(true);
    expect(system[1].text).toContain('MEMORY-MARK');
    expect(system[1].text).not.toContain('PERSONA-MARK');
    expect(system[1].text).not.toContain('你是 DeskMinis');
    expect('cache_control' in system[1]).toBe(false);
    // 整个请求的缓存断点不超过 4 个
    expect(JSON.stringify(held.request.body).split('"cache_control"').length - 1).toBeLessThanOrEqual(4);
    // 上下文条的分列与请求体里的两块是同一份：稳定段就是第 1 块，动态段是剩下的那一块
    expect(live.live).toBe(true);
    const i = live.budget!.input;
    expect(i.calibration.calibrated).toBe(false);
    expect(i.components.system).toBe(estimateTextTokens(`${String(system[0].text)}\n\n${String(system[1].text)}`));
    expect(i.systemStable).toBe(estimateTextTokens(String(system[0].text)));
    expect(i.systemDynamic).toBe(i.components.system - i.systemStable);
    expect(Math.abs(i.systemDynamic - estimateTextTokens(String(system[1].text)))).toBeLessThanOrEqual(2);
    expect(i.systemStable).not.toBe(i.systemDynamic);
    expect((await held.finish()).at(-1)).toMatchObject({ kind: 'turnEnd' });
    c.close();
  }, 60000);

  const REASON_ONLY_URL = '/relay/reasononly/v1/chat/completions';
  const BACKUP_URL = '/relay/v1/chat/completions';
  const FALLBACK_CAP_WAY = '这个输出上限是目录没有可用记录时的兜底值，确认模型的真实上限后可在「设置 → 模型 → 编辑 → 手动修正」填写最大输出，或换用模型';

  it('E13 模型组首成员的输出额度被推理用完（正文为空、以 length 收尾）、这次的 max_tokens 是模型自己的上限：本轮换到备用并得到回答，不当空响应、不算故障——会话仍绑定模型组，下一条消息仍先给首成员；没有备用时仍报截断', async () => {
    const srv = await boot();
    const c = rpcClient(srv.port, srv.authToken); await c.ready;
    const first = await create(c, '只会想', relay('reasononly/'), 'unlisted-model', { contextWindow: 64_000 });
    const second = await create(c, '备用', relay(), 'unlisted-model', { contextWindow: 64_000 });
    const g = (await c.call('modelgroup.create', { name: '想太多', memberIds: [first.id, second.id] })).result;
    const sid = await session(c, `group:${g.id}`);
    const t = await turn(c, { sessionId: sid, text: 'hello' });
    expect(t.error).toBeUndefined();
    // 请求序列：首成员 1 次（按它自己的上限申请）、备用 1 次
    expect(t.requests.map(r => r.url)).toEqual([REASON_ONLY_URL, BACKUP_URL]);
    expect(t.requests[0].body.max_tokens).toBe(8_192);
    // 一条带 cause 的降级事件，原来写在错误里的说明留在它的 reason 里；没有 error，也没有「空响应」
    const hops = t.events.filter(e => e.kind === 'fallback');
    expect(hops).toHaveLength(1);
    expect(hops[0]).toMatchObject({ from: '只会想(unlisted-model)', to: '备用(unlisted-model)', cause: 'outputLimit' });
    expect(hops[0].reason).toContain('这次输出被 max_tokens 截断，没有产出正文');
    expect(hops[0].reason).not.toContain('空响应');
    // 说明按那次请求实际的情况写：没带推理参数、8,192 是兜底上限——不让人去「调低推理档位」
    // （照做后首成员收到的请求与这一次逐字节相同），指向手动填写最大输出或换用模型
    expect('reasoning_effort' in t.requests[0].body).toBe(false);
    expect(hops[0].reason).not.toContain('推理档位');
    expect(hops[0].reason).toContain(FALLBACK_CAP_WAY);
    expect(t.events.some(e => e.kind === 'error')).toBe(false);
    expect(t.events.at(-1)).toEqual({ kind: 'turnEnd', stopReason: 'endTurn' });
    // 首成员没有出故障：不改绑；首成员那次只有推理的回复不落库，落下的是备用的回答
    expect(await bindingOf(c, sid)).toBe(`group:${g.id}`);
    expect((await messages(c, sid)).map(m => m.role)).toEqual(['user', 'assistant']);
    // 同一会话的下一条消息仍从首成员起步
    const next = await turn(c, { sessionId: sid, text: 'again' });
    expect(next.requests.map(r => r.url)).toEqual([REASON_ONLY_URL, BACKUP_URL]);
    expect(await bindingOf(c, sid)).toBe(`group:${g.id}`);

    // 没有备用（会话直接绑这个配置）：仍报截断，说明就是唯一的出路
    const solo = await session(c, `provider:${first.id}`);
    const s = await turn(c, { sessionId: solo, text: 'hello' });
    expect(s.requests.map(r => r.url)).toEqual([REASON_ONLY_URL]);
    expect(s.events.some(e => e.kind === 'fallback')).toBe(false);
    const err = s.events.at(-1)!;
    expect(err).toMatchObject({ kind: 'error', code: 'outputLimit', outputLimit: { requested: 8_192, limitedBy: 'model', continued: 0 } });
    expect(err.message).toContain('这次输出被 max_tokens 截断，没有产出正文');
    expect(err.message).not.toContain('空响应');
    expect(err.message).not.toContain('推理档位');
    expect(err.message).toContain(FALLBACK_CAP_WAY);
    // 与组里换槽时写进 reason 的是逐字相同的一句
    expect(err.message).toBe(hops[0].reason);
    expect(await bindingOf(c, solo)).toBe(`provider:${first.id}`);
    expect((await messages(c, solo)).map(m => m.role)).toEqual(['user']);
    c.close();
  }, 60000);

  it('E15 首成员的 max_tokens 是手动填的最大输出、被推理用完：同样换到备用、不改绑；接手的成员随后故障降级也不改绑（第一跳不是故障）；第一跳是故障时改绑到最后跑通的成员', async () => {
    const srv = await boot();
    const c = rpcClient(srv.port, srv.authToken); await c.ready;
    const first = await create(c, '只会想', relay('reasononly/'), 'unlisted-model', { contextWindow: 64_000, maxOutputTokens: 4_000 });
    const limited = await create(c, '限流', relay('fail/'), 'unlisted-model', { contextWindow: 64_000 });
    const backup = await create(c, '备用', relay(), 'unlisted-model', { contextWindow: 64_000 });
    const g = (await c.call('modelgroup.create', { name: '手动上限', memberIds: [first.id, backup.id] })).result;
    const sid = await session(c, `group:${g.id}`);
    const t = await turn(c, { sessionId: sid, text: 'hello' });
    expect(t.error).toBeUndefined();
    expect(t.requests.map(r => r.url)).toEqual([REASON_ONLY_URL, BACKUP_URL]);
    expect(t.requests[0].body.max_tokens).toBe(4_000);
    const hops = t.events.filter(e => e.kind === 'fallback');
    expect(hops).toHaveLength(1);
    expect(hops[0]).toMatchObject({ from: '只会想(unlisted-model)', to: '备用(unlisted-model)', cause: 'outputLimit' });
    expect(hops[0].reason).toContain('输出额度（max_tokens 4000）在正文之前就用完了');
    expect(hops[0].reason).toContain('可调高手动填写的最大输出后重发');
    expect(t.events.at(-1)).toEqual({ kind: 'turnEnd', stopReason: 'endTurn' });
    expect(await bindingOf(c, sid)).toBe(`group:${g.id}`);
    const next = await turn(c, { sessionId: sid, text: 'again' });
    expect(next.requests[0].url).toBe(REASON_ONLY_URL);

    // 第一跳是按输出额度换的，接手的成员又被限流、再降到第三个：首成员没有出过故障，这次运行不改绑
    const g2 = (await c.call('modelgroup.create', { name: '先想后限流', memberIds: [first.id, limited.id, backup.id] })).result;
    const s2 = await session(c, `group:${g2.id}`);
    const t2 = await turn(c, { sessionId: s2, text: 'hello' });
    expect(t2.requests.map(r => r.url)).toEqual([REASON_ONLY_URL, '/relay/fail/v1/chat/completions', BACKUP_URL]);
    expect(t2.events.filter(e => e.kind === 'fallback').map(e => e.cause)).toEqual(['outputLimit', undefined]);
    expect(t2.events.at(-1)).toEqual({ kind: 'turnEnd', stopReason: 'endTurn' });
    expect(await bindingOf(c, s2)).toBe(`group:${g2.id}`);
    const next2 = await turn(c, { sessionId: s2, text: 'again' });
    expect(next2.requests[0].url).toBe(REASON_ONLY_URL);

    // 反过来：第一跳是故障（首成员被限流），接手的成员把输出用完、再换到第三个。首成员出过故障，照原规则改绑——
    // 改绑到最后接手并跑通的成员（与纯故障链相同）。不能停在中间那个：它这一轮没有给出回答，会话只绑它的话，
    // 下一条消息它再把输出用完就没有备用可换（评审 B1 / C1）
    const g3 = (await c.call('modelgroup.create', { name: '先限流后想', memberIds: [limited.id, first.id, backup.id] })).result;
    const s3 = await session(c, `group:${g3.id}`);
    const t3 = await turn(c, { sessionId: s3, text: 'hello' });
    expect(t3.requests.map(r => r.url)).toEqual(['/relay/fail/v1/chat/completions', REASON_ONLY_URL, BACKUP_URL]);
    expect(t3.events.filter(e => e.kind === 'fallback').map(e => e.cause)).toEqual([undefined, 'outputLimit']);
    expect(t3.events.at(-1)).toEqual({ kind: 'turnEnd', stopReason: 'endTurn' });
    expect(await bindingOf(c, s3)).toBe(`provider:${backup.id}`);
    const next3 = await turn(c, { sessionId: s3, text: 'again' });
    expect(next3.requests.map(r => r.url)).toEqual([BACKUP_URL]);
    expect(next3.events.some(e => e.kind === 'fallback' || e.kind === 'error')).toBe(false);
    expect(next3.events.at(-1)).toEqual({ kind: 'turnEnd', stopReason: 'endTurn' });
    expect((await messages(c, s3)).map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);

    // 再长一段：限流 → 把输出用完 → 又一个限流 → 备用。按输出额度的那一跳之后还有故障降级，改绑候选一路跟到最后跑通的备用
    const limited2 = await create(c, '限流2', relay('fail/'), 'unlisted-model', { contextWindow: 64_000 });
    const g4 = (await c.call('modelgroup.create', { name: '限流想限流', memberIds: [limited.id, first.id, limited2.id, backup.id] })).result;
    const s4 = await session(c, `group:${g4.id}`);
    const t4 = await turn(c, { sessionId: s4, text: 'hello' });
    expect(t4.requests.map(r => r.url)).toEqual(['/relay/fail/v1/chat/completions', REASON_ONLY_URL, '/relay/fail/v1/chat/completions', BACKUP_URL]);
    expect(t4.events.filter(e => e.kind === 'fallback').map(e => [e.to, e.cause])).toEqual([
      ['只会想(unlisted-model)', undefined], ['限流2(unlisted-model)', 'outputLimit'], ['备用(unlisted-model)', undefined],
    ]);
    expect(t4.events.at(-1)).toEqual({ kind: 'turnEnd', stopReason: 'endTurn' });
    expect(await bindingOf(c, s4)).toBe(`provider:${backup.id}`);

    // 链上再没有接住的：限流 → 把输出用完 → 限流。没有 turnEnd，不改绑；报的是中间那个成员的截断说明（它没有坏），不是「所有模型均不可用」
    const g5 = (await c.call('modelgroup.create', { name: '限流想再限流', memberIds: [limited.id, first.id, limited2.id] })).result;
    const s5 = await session(c, `group:${g5.id}`);
    const t5 = await turn(c, { sessionId: s5, text: 'hello' });
    expect(t5.requests.map(r => r.url)).toEqual(['/relay/fail/v1/chat/completions', REASON_ONLY_URL, '/relay/fail/v1/chat/completions']);
    const err5 = t5.events.at(-1)!;
    expect(err5).toMatchObject({ kind: 'error', code: 'outputLimit', outputLimit: { requested: 4_000, limitedBy: 'manual', continued: 0 } });
    expect(err5.message).toContain('只会想(unlisted-model) 这次输出被 max_tokens 截断，没有产出正文');
    expect(err5.message).toContain('可调高手动填写的最大输出后重发。随后换用的备用模型也没有给出回答（最后的错误：');
    expect(err5.message).toContain('rate limited (mock)');
    expect(err5.message).not.toContain('所有模型均不可用');
    expect(await bindingOf(c, s5)).toBe(`group:${g5.id}`);
    c.close();
  }, 60000);

  it('E16 对照：首成员的 max_tokens 是按默认额度申请的、或被剩余空间收紧的——输出被推理用完时仍报截断，备用一次请求都不收，绑定不变', async () => {
    const srv = await boot();
    const c = rpcClient(srv.port, srv.authToken); await c.ready;
    const backup = await create(c, '备用', relay(), 'unlisted-model', { contextWindow: 64_000 });
    const expectTruncated = async (name: string, firstId: string, limitedBy: string) => {
      const g = (await c.call('modelgroup.create', { name, memberIds: [firstId, backup.id] })).result;
      const sid = await session(c, `group:${g.id}`);
      const t = await turn(c, { sessionId: sid, text: 'hello' });
      expect(t.error, name).toBeUndefined();
      expect(t.requests, name).toHaveLength(1);
      expect(t.requests[0].url, name).toContain('/reasononly/');
      expect(t.events.some(e => e.kind === 'fallback'), name).toBe(false);
      const err = t.events.at(-1)!;
      expect(err, name).toMatchObject({ kind: 'error', code: 'outputLimit', outputLimit: { requested: t.requests[0].body.max_tokens, limitedBy, continued: 0 } });
      expect(await bindingOf(c, sid), name).toBe(`group:${g.id}`);
      expect((await messages(c, sid)).map(m => m.role), name).toEqual(['user']);
      return { request: t.requests[0], err };
    };

    // 默认额度：收录端点上输出上限 128,000 的型号，这次按 65,536 申请
    const dflt = await create(c, '默认额度', vendorA('/reasononly'), 'ind-model');
    const d = await expectTruncated('默认额度先', dflt.id, 'preference');
    expect(d.request.url).toBe('/vendor-a/v1/reasononly/chat/completions');
    expect(d.request.body.max_tokens).toBe(65_536);
    expect(d.err.message).toContain('这次按默认额度申请输出');

    // 被剩余空间收紧：手动窗口取固定开销的 3 倍、手动最大输出填得和窗口一样大——额度只能是剩下的那部分
    const probe = await info(c, await session(c, `provider:${backup.id}`));
    const fixed = probe.budget!.input.components.system + probe.budget!.input.components.tools;
    expect(fixed).toBeGreaterThan(1_000);
    const tight = await create(c, '窗口紧', relay('reasononly/'), 'unlisted-model', { contextWindow: fixed * 3, maxOutputTokens: fixed * 3 });
    const w = await expectTruncated('窗口紧先', tight.id, 'window');
    expect(w.request.body.max_tokens).toBeLessThan(fixed * 3);
    expect(w.err.message).toContain('上下文剩余空间不足，这次的 max_tokens 是收紧过的');
    c.close();
  }, 60000);

  it('E17 按输出额度换到备用之后对话继续增长、到了备用的压缩档：仍按备用的窗口压缩并写下压缩记录；会话不改绑，下一条消息仍先给首成员，它收到的是摘要（复审 R2：接受的行为，钉住）', async () => {
    const TOOLONCE_URL = '/relay/toolonce/v1/chat/completions';
    const srv = await boot();
    const c = rpcClient(srv.port, srv.authToken); await c.ready;
    const first = await create(c, '只会想', relay('reasononly/'), 'unlisted-model', { contextWindow: 1_000_000 });
    const backup = await create(c, '备用', relay('toolonce/'), 'unlisted-model', { contextWindow: 100_000 });
    const g = (await c.call('modelgroup.create', { name: '想太多', memberIds: [first.id, backup.id] })).result;
    const sid = await session(c, `group:${g.id}`);
    // 真实系统提示与内置工具的固定开销先量出来，历史按它配：换用的那一刻对备用占 40% 左右
    // （窗口 100,000 的修剪档是 50%、压缩档 70%，这时不到档，照常接手）
    const probe = await info(c, await session(c, `provider:${backup.id}`));
    const fixed = probe.budget!.input.components.system + probe.budget!.input.components.tools;
    expect(fixed).toBeGreaterThan(1_000);
    expect(fixed).toBeLessThan(20_000);
    const per = Math.floor((40_000 - fixed) / 8) * 4;
    const filler = (n: number): string => 'lorem ipsum dolor sit amet '.repeat(Math.ceil(n / 27)).slice(0, n);
    // 用第二个连接落 4 组长问答（时间戳放在一分钟前，随后真发的那条排在它们之后）
    const db = openDb(join(srv.dataDir, 'minis.db'));
    try {
      const store = new ChatStore(db);
      let at = store.nowEpoch() - 60;
      const add = (role: 'user' | 'assistant', text: string) =>
        store.appendMessage({ id: store.newId(), sessionId: sid, role, parts: [{ type: 'text', value: text }], createdAt: (at += 0.01), streamInterruptCount: 0 });
      for (let i = 1; i <= 4; i++) { add('user', `question ${i}: ${filler(per)}`); add('assistant', `answer ${i}: ${filler(per)}`); }
    } finally { db.close(); }
    expect(await messages(c, sid)).toHaveLength(8);

    // 首成员把输出用完 → 换到备用；备用第一次回复带一段约 38,000 token 的正文并调工具，对话涨到它的 78% 左右
    const isSummary = (r: { body: Body }): boolean => r.body.messages?.[0]?.role === 'system' && r.body.messages[0].content === '你是对话摘要助手。';
    const t = await turn(c, { sessionId: sid, text: 'hello' });
    expect(t.error).toBeUndefined();
    // 请求序列：首成员 1 次；备用 3 次——正式请求（原文）、摘要请求、正式请求（摘要 + 最近的原文）
    expect(t.requests.map(r => [r.url, isSummary(r)])).toEqual([[REASON_ONLY_URL, false], [TOOLONCE_URL, false], [TOOLONCE_URL, true], [TOOLONCE_URL, false]]);
    expect(t.events.filter(e => e.kind === 'fallback').map(e => [e.to, e.cause])).toEqual([['备用(unlisted-model)', 'outputLimit']]);
    // 换用的那一刻没有因为「要先压缩 / 放不下」跳过备用，压缩发生在它调过工具之后
    expect(t.events.some(e => e.kind === 'capability' && (e.notices as string[]).some(n => n.startsWith('已跳过')))).toBe(false);
    expect(t.events.filter(e => e.kind === 'compacted')).toHaveLength(1);
    expect(t.events.findIndex(e => e.kind === 'compacted')).toBeGreaterThan(t.events.findIndex(e => e.kind === 'toolEnd'));
    expect(t.events.some(e => e.kind === 'error')).toBe(false);
    expect(t.events.at(-1)).toEqual({ kind: 'turnEnd', stopReason: 'endTurn' });
    expect(JSON.stringify(t.requests[1].body.messages)).toContain('question 1: ');
    const afterCompact = JSON.stringify(t.requests[3].body.messages);
    expect(afterCompact).toContain(TOOLONCE_SUMMARY);
    // F03：压缩后的请求在程序记录里带第一条用户指示的原话，超过 800 字符只留头 600、尾 200 并注明省略了中间。所以开头那几个字会出现，
    // 但头部到 600 个字符为止：「question 1: 」后面跟满 600 个字符的前缀（共 612）已经越过截断点，不该出现——截断失效或带出大半原文时这里会红
    expect(afterCompact).not.toContain(`question 1: ${filler(600)}`);
    expect(afterCompact).toContain('（原话过长，已省略中间部分）');
    expect(afterCompact).toContain('question 3: ');
    // 压缩记录已落库
    const db2 = openDb(join(srv.dataDir, 'minis.db'));
    try { expect(new ChatStore(db2).getLatestCompactMarker(sid)?.summary).toContain(TOOLONCE_SUMMARY); } finally { db2.close(); }

    // 会话仍绑模型组；下一条消息仍先给首成员——它的窗口 1,000,000 还空着，收到的却是摘要，不是早先的原文
    expect(await bindingOf(c, sid)).toBe(`group:${g.id}`);
    const next = await turn(c, { sessionId: sid, text: 'again' });
    expect(next.requests.map(r => r.url)).toEqual([REASON_ONLY_URL, TOOLONCE_URL]);
    const mainBody = JSON.stringify(next.requests[0].body.messages);
    expect(mainBody).toContain(TOOLONCE_SUMMARY);
    expect(mainBody).not.toContain(`question 1: ${filler(600)}`);
    expect(mainBody).toContain('（原话过长，已省略中间部分）');
    expect(next.events.at(-1)).toEqual({ kind: 'turnEnd', stopReason: 'endTurn' });
    expect(await bindingOf(c, sid)).toBe(`group:${g.id}`);
    c.close();
  }, 60000);

  it('E18 按输出额度换过去的成员自己回了空响应、再降到后面的小窗口成员：按它的窗口压缩并写下压缩记录（对话没有增长）；第一跳不是故障，会话不改绑，下一条消息仍先给首成员，它收到的是摘要（终审：接受的行为，钉住）', async () => {
    const EMPTY_URL = '/relay/empty/v1/chat/completions';
    const SUMMARY_URL = '/relay/summary/v1/chat/completions';
    const srv = await boot();
    const c = rpcClient(srv.port, srv.authToken); await c.ready;
    const first = await create(c, '只会想', relay('reasononly/'), 'unlisted-model', { contextWindow: 1_000_000 });
    const blank = await create(c, '空响应', relay('empty/'), 'unlisted-model', { contextWindow: 1_000_000 });
    const backup = await create(c, '备用', relay('summary/'), 'unlisted-model', { contextWindow: 100_000 });
    const g = (await c.call('modelgroup.create', { name: '想太多又空手', memberIds: [first.id, blank.id, backup.id] })).result;
    const sid = await session(c, `group:${g.id}`);
    // 历史按固定开销配：对备用占 76% 左右（窗口 100,000 的压缩档是 70%），对前两个成员不到 8%
    const probe = await info(c, await session(c, `provider:${backup.id}`));
    const fixed = probe.budget!.input.components.system + probe.budget!.input.components.tools;
    expect(fixed).toBeGreaterThan(1_000);
    expect(fixed).toBeLessThan(20_000);
    const per = Math.floor((76_000 - fixed) / 8) * 4;
    const filler = (n: number): string => 'lorem ipsum dolor sit amet '.repeat(Math.ceil(n / 27)).slice(0, n);
    const db = openDb(join(srv.dataDir, 'minis.db'));
    try {
      const store = new ChatStore(db);
      let at = store.nowEpoch() - 60;
      const add = (role: 'user' | 'assistant', text: string) =>
        store.appendMessage({ id: store.newId(), sessionId: sid, role, parts: [{ type: 'text', value: text }], createdAt: (at += 0.01), streamInterruptCount: 0 });
      for (let i = 1; i <= 4; i++) { add('user', `question ${i}: ${filler(per)}`); add('assistant', `answer ${i}: ${filler(per)}`); }
    } finally { db.close(); }

    const isSummary = (r: { body: Body }): boolean => r.body.messages?.[0]?.role === 'system' && r.body.messages[0].content === '你是对话摘要助手。';
    const t = await turn(c, { sessionId: sid, text: 'hello' });
    expect(t.error).toBeUndefined();
    // 请求序列：首成员 1 次、空响应的成员 1 次（原文）、备用 2 次——摘要请求、正式请求（摘要 + 最近的原文）
    expect(t.requests.map(r => [r.url, isSummary(r)])).toEqual([[REASON_ONLY_URL, false], [EMPTY_URL, false], [SUMMARY_URL, true], [SUMMARY_URL, false]]);
    // 两跳：按输出额度（带 cause）、空响应（故障降级，不带 cause）；备用没有因为「要先压缩」被跳过
    expect(t.events.filter(e => e.kind === 'fallback').map(e => [e.to, e.cause, e.cause === undefined ? e.reason : ''])).toEqual([
      ['空响应(unlisted-model)', 'outputLimit', ''], ['备用(unlisted-model)', undefined, '空响应'],
    ]);
    expect(t.events.some(e => e.kind === 'capability' && (e.notices as string[]).some(n => n.startsWith('已跳过')))).toBe(false);
    expect(t.events.filter(e => e.kind === 'compacted')).toHaveLength(1);
    expect(t.events.some(e => e.kind === 'error')).toBe(false);
    expect(t.events.at(-1)).toEqual({ kind: 'turnEnd', stopReason: 'endTurn' });
    expect(JSON.stringify(t.requests[1].body.messages)).toContain('question 1: ');
    const afterCompact = JSON.stringify(t.requests[3].body.messages);
    expect(afterCompact).toContain(TOOLONCE_SUMMARY);
    // F03：压缩后的请求在程序记录里带第一条用户指示的原话，超过 800 字符只留头 600、尾 200 并注明省略了中间。所以开头那几个字会出现，
    // 但头部到 600 个字符为止：「question 1: 」后面跟满 600 个字符的前缀（共 612）已经越过截断点，不该出现——截断失效或带出大半原文时这里会红
    expect(afterCompact).not.toContain(`question 1: ${filler(600)}`);
    expect(afterCompact).toContain('（原话过长，已省略中间部分）');
    const db2 = openDb(join(srv.dataDir, 'minis.db'));
    try { expect(new ChatStore(db2).getLatestCompactMarker(sid)?.summary).toContain(TOOLONCE_SUMMARY); } finally { db2.close(); }

    // 首成员没有出过故障：会话仍绑模型组；下一条消息仍先给它——窗口 1,000,000 还空着，收到的却是摘要
    expect(await bindingOf(c, sid)).toBe(`group:${g.id}`);
    const next = await turn(c, { sessionId: sid, text: 'again' });
    expect(next.requests[0].url).toBe(REASON_ONLY_URL);
    const mainBody = JSON.stringify(next.requests[0].body.messages);
    expect(mainBody).toContain(TOOLONCE_SUMMARY);
    expect(mainBody).not.toContain(`question 1: ${filler(600)}`);
    expect(mainBody).toContain('（原话过长，已省略中间部分）');
    expect(next.events.at(-1)).toEqual({ kind: 'turnEnd', stopReason: 'endTurn' });
    expect(await bindingOf(c, sid)).toBe(`group:${g.id}`);
    c.close();
  }, 60000);

  /** 请求体（Anthropic 形状）里的图片块数。 */
  const imageBlocks = (body: Body): number =>
    (body.messages as Body[]).flatMap(m => Array.isArray(m.content) ? m.content as Body[] : []).filter(b => b.type === 'image').length;

  it('E14 带图会话往下聊：空闲推算与下一次请求对图片是同一个口径——只保留最近两轮（含将要发的那条），更早的图片按占位文字算', async () => {
    const srv = await boot();
    const c = rpcClient(srv.port, srv.authToken); await c.ready;
    const inst = (await c.call('provider.instances.create', {
      name: 'Claude 中转', kind: 'anthropic', baseUrl: base('claude/hold-e14'), modelId: 'claude-relay', apiKey: 'test-key', contextWindow: 200_000,
      capabilityOverrides: { imageInput: true },
    })).result as { id: string };
    const sid = await session(c, `provider:${inst.id}`);
    const dir = join(srv.dataDir, 'sessions', sid, 'attachments');
    mkdirSync(dir, { recursive: true });
    // 两张 3000×3000 的图：Anthropic 的 28 px 网格下每张都到单张上限 4,784
    writeFileSync(join(dir, 'a.png'), pngBytes(3000, 3000, 120_000));
    writeFileSync(join(dir, 'b.png'), pngBytes(3000, 3000, 120_000));
    const PER_IMAGE = 4_784;

    // 第 1 轮带两张图。答完后的空闲推算：下一次请求的保留窗口是「将要发的那条 + 第 1 轮」，两张图还在
    const one = await turn(c, { sessionId: sid, text: 'compare these two', attachments: ['attachments/a.png', 'attachments/b.png'] });
    expect(one.events.at(-1)).toMatchObject({ kind: 'turnEnd' });
    expect(imageBlocks(one.requests[0].body)).toBe(2);
    const afterOne = await info(c, sid);
    expect(afterOne.live).toBe(false);
    expect(afterOne.budget!.input).toMatchObject({ imageCount: 2, mediaBasis: 'formula' });
    expect(afterOne.budget!.input.components.media).toBe(2 * PER_IMAGE);

    // 第 2 轮纯文字：请求里两张图仍在（保留窗口 = 第 2 轮 + 第 1 轮），与刚才的推算一致
    const two = await turn(c, { sessionId: sid, text: 'thanks' });
    expect(two.events.at(-1)).toMatchObject({ kind: 'turnEnd' });
    expect(imageBlocks(two.requests[0].body)).toBe(2);

    // 第 2 轮答完后的空闲推算：下一次请求的保留窗口是「将要发的那条 + 第 2 轮」，第 1 轮的图届时已换成占位文字，不该再按图片算
    const idle = await info(c, sid);
    expect(idle.live).toBe(false);
    expect(idle.budget!.input).toMatchObject({ imageCount: 0, mediaBasis: 'none' });
    expect(idle.budget!.input.components.media).toBe(0);
    expect(idle.usedTokens).toBeLessThan(afterOne.usedTokens - 2 * PER_IMAGE + 200);

    // 把窗口改到「连那两张图一起算就放不下」的大小：图片被错算进去时，条上会挂出一条实际不会发生的
    // 「仍会发送，端点可能拒绝」并把 max_tokens 说成收紧到下限
    const window = Math.round((idle.usedTokens + 2 * PER_IMAGE) * 1.12);
    expect((await c.call('provider.instances.update', { id: inst.id, contextWindow: window })).error).toBeUndefined();
    const tight = await info(c, sid);
    expect(tight.windowTokens).toBe(window);
    expect(tight.budget!.input.imageCount).toBe(0);
    expect(tight.budget!.status).toBe('ok');
    expect(tight.budget!.reason).toBeUndefined();
    expect(tight.budget!.output.limitedBy).not.toBe('floor');

    // 随后真发第 3 条并挂住：请求体里没有图片块，第 1 轮那条消息里是两句占位文字；运行中的预算与刚才的推算只差这条新消息
    const held = await heldTurn(c, 'e14', { sessionId: sid, text: 'x' });
    expect(imageBlocks(held.request.body)).toBe(0);
    const firstUser = JSON.stringify(held.request.body.messages[0]);
    expect(firstUser).toContain('[图片 a.png 已随上下文省略]');
    expect(firstUser).toContain('[图片 b.png 已随上下文省略]');
    const busy = await info(c, sid);
    expect(busy.live).toBe(true);
    expect(busy.budget!.input).toMatchObject({ imageCount: 0, mediaBasis: 'none' });
    expect(busy.budget!.input.components.media).toBe(0);
    expect(busy.budget!.input.components.system).toBe(tight.budget!.input.components.system);
    expect(busy.budget!.input.components.tools).toBe(tight.budget!.input.components.tools);
    const delta = busy.budget!.input.components.history - tight.budget!.input.components.history;
    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeLessThanOrEqual(64);
    expect(busy.usedTokens - tight.usedTokens).toBe(delta);
    expect(busy.budget!.status).toBe(tight.budget!.status);
    // 工具定义增大后，这个小窗口可能开始收紧输出。空闲预览不含新消息，实际输入增加 delta，
    // 可用输出应精确减少 delta 和余量增量；不能假设 max_tokens 始终不变。
    // 独立按共享窗口约束核对数值，再用真实端点收到的 max_tokens 交叉核对。
    const available = Math.min(busy.budget!.output.cap,
      window - busy.usedTokens - busy.budget!.safetyMargin);
    expect(busy.budget!.output.available).toBe(available);
    const expectedOutput = Math.min(busy.budget!.output.preference,
      Math.max(Math.min(1_024, busy.budget!.output.preference), available));
    expect(busy.budget!.output.requested).toBe(expectedOutput);
    expect(held.request.body.max_tokens).toBe(expectedOutput);
    if (tight.budget!.output.limitedBy === 'window' && busy.budget!.output.limitedBy === 'window') {
      expect(tight.budget!.output.requested - busy.budget!.output.requested)
        .toBe(delta + busy.budget!.safetyMargin - tight.budget!.safetyMargin);
    }
    expect((await held.finish()).at(-1)).toMatchObject({ kind: 'turnEnd' });
    c.close();
  }, 60000);

  it('E14b 上一轮带图、会话随后绑到不收图片的模型：空闲推算仍出预算（将要发的那条才是当前轮，上一轮的图按文字占位算），与随后的请求一致', async () => {
    const srv = await boot();
    const c = rpcClient(srv.port, srv.authToken); await c.ready;
    const anthropic = async (name: string, baseUrl: string, imageInput: boolean): Promise<{ id: string }> => (await c.call('provider.instances.create', {
      name, kind: 'anthropic', baseUrl, modelId: 'claude-relay', apiKey: 'test-key', contextWindow: 200_000, capabilityOverrides: { imageInput },
    })).result as { id: string };
    const vision = await anthropic('能看图', base('claude'), true);
    const blind = await anthropic('看不了图', base('claude/hold-e14b'), false);
    const sid = await session(c, `provider:${vision.id}`);
    const dir = join(srv.dataDir, 'sessions', sid, 'attachments');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'shot.png'), pngBytes(1000, 1000, 120_000));
    expect((await turn(c, { sessionId: sid, text: 'what is this', attachments: ['attachments/shot.png'] })).events.at(-1)).toMatchObject({ kind: 'turnEnd' });
    expect((await info(c, sid)).budget!.input.imageCount).toBe(1);

    // 改绑到不收图片的配置。上一条带图的消息已经答完，它不是「当前轮」：下一条文字消息这个槽位接得住，历史图片改以文字占位
    await c.call('chat.sessions.setModelBinding', { sessionId: sid, binding: `provider:${blind.id}` });
    const idle = await info(c, sid);
    expect(idle.live).toBe(false);
    expect(idle.budget).toBeDefined();
    expect(idle.budget!.slot.label).toBe('看不了图(claude-relay)');
    expect(idle.budget!.input).toMatchObject({ imageCount: 0, mediaBasis: 'none' });
    expect(idle.usedTokens).toBe(idle.budget!.input.tokens);

    const held = await heldTurn(c, 'e14b', { sessionId: sid, text: 'x' });
    expect(imageBlocks(held.request.body)).toBe(0);
    expect(JSON.stringify(held.request.body.messages[0])).toContain('[图片未发送：看不了图(claude-relay) 不支持图片输入]');
    const busy = await info(c, sid);
    expect(busy.live).toBe(true);
    expect(busy.budget!.input.imageCount).toBe(0);
    expect(busy.budget!.input.components.system).toBe(idle.budget!.input.components.system);
    expect(busy.budget!.input.components.tools).toBe(idle.budget!.input.components.tools);
    const delta = busy.budget!.input.components.history - idle.budget!.input.components.history;
    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeLessThanOrEqual(64);
    expect(busy.budget!.output.requested).toBe(idle.budget!.output.requested);
    expect(held.request.body.max_tokens).toBe(idle.budget!.output.requested);
    expect((await held.finish()).at(-1)).toMatchObject({ kind: 'turnEnd' });
    c.close();
  }, 60000);
});
