/**
 * F01 端到端：真 minisd（startMinisd）+ JSON-RPC + 本地假 OpenAI 端点，从配置实例一路到发出的请求体。
 * 目录用夹具预先写好缓存（新鲜缓存不触发联网刷新），服务商 api 地址指向本地假端点——
 * 同一个 shared-model，经 /vendor-a 与 /vendor-b 两个「服务商」接入时各按自己的目录记录与手动修正解析。
 * 覆盖：验收 1（分别解析、清空 / 删除 / 重启）、验收 2（组内降级的推理参数正反两向）、
 * 验收 3（不收图片的配置拒发且不落库；组内按能力切换不改绑）、验收 4（草稿解析不带密钥、不发请求）。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMinisd } from '../src/minisd/index';
import { ModelCatalog } from '../src/minisd/providers/model-catalog';
import { catalogFixtureF01R, jsonResponse } from './runtime-model-fixture';

let mock: Server;
let mockPort = 0;
const hits: { url: string; body: Record<string, any> }[] = [];
const TINY_PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f030005fe02fea72d99480000000049454e44ae426082', 'hex');

beforeAll(async () => {
  mock = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, any>;
      hits.push({ url: String(req.url), body });
      if (req.url?.includes('/fail/')) {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'rate limited (mock)' } }));
        return;
      }
      // F01R：/strict-<N>/ 按「输入 + max_tokens ≤ 窗口 N」校验（Moonshot / vLLM 系的规则），超了回 Kimi 式的超限 400
      const strict = /\/strict-(\d+)\//.exec(req.url ?? '');
      if (strict) {
        const requested = Number(body.max_tokens ?? 0) + Math.ceil(JSON.stringify(body.messages ?? []).length / 4);
        if (requested > Number(strict[1])) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `Invalid request: Your request exceeded model token limit: ${strict[1]} (requested: ${requested})` } }));
          return;
        }
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '收到' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>(r => mock.listen(0, '127.0.0.1', () => r()));
  mockPort = (mock.address() as { port: number }).port;
  // F01R：回环地址不再参与目录 api 匹配（C2），夹具里的「服务商 api」改用保留域名（.test 不解析）。
  // 真 Provider 构造时取全局 fetch，这里只把这个域名改写回本地假端点——请求仍是真 HTTP；改写没生效时域名解析失败、用例变红
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: unknown, init?: unknown) =>
    realFetch(typeof input === 'string' ? input.replace(`http://${MOCK_HOST}:${mockPort}/`, `http://127.0.0.1:${mockPort}/`) : input as never, init as never));
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await new Promise<void>(r => mock.close(() => r()));
});

const MOCK_HOST = 'f01-mock.test';
const api = (vendor: string) => `http://${MOCK_HOST}:${mockPort}/${vendor}/v1`;
/** 不匹配任何目录 api 的中转地址（同一个假端点）。 */
const relayUrl = () => `http://${MOCK_HOST}:${mockPort}/relay/v1`;
/** 真回环地址：夹具里 loop-lab 把它登记成了自己的 api。 */
const loopUrl = () => `http://127.0.0.1:${mockPort}/loop/v1`;

let stop: (() => Promise<void>) | undefined;
const savedFake = process.env.DESKMINIS_FAKE_PROVIDER;
afterEach(async () => {
  await stop?.(); stop = undefined;
  if (savedFake === undefined) delete process.env.DESKMINIS_FAKE_PROVIDER; else process.env.DESKMINIS_FAKE_PROVIDER = savedFake;
});

/** 先用产品自己的缓存写法落一份新鲜目录（api 地址指向本地假端点），再起 minisd。
 *  prepare：全新数据目录在启动之前的布置（比如先放一个技能目录，让启动时的孤儿回收把它入库）。 */
async function boot(dataDir?: string, prepare?: (dir: string) => void) {
  const dir = dataDir ?? mkdtempSync(join(tmpdir(), 'dm-f01-'));
  if (!dataDir) {
    const seed = new ModelCatalog(join(dir, 'models-dev-cache.json'), async () => jsonResponse(catalogFixtureF01R({ vendorA: api('vendor-a'), vendorB: api('vendor-b'), tie: api('tie'), loopback: loopUrl() })));
    expect(await seed.refresh(true)).toBe(true);
    prepare?.(dir);
  }
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

/** 建会话并先改名（自动命名只在默认标题时动手，它的请求会混进假端点的记录），再绑定。 */
async function session(c: Client, binding: string): Promise<string> {
  const s = (await c.call('chat.sessions.create', {})).result;
  await c.call('chat.sessions.rename', { sessionId: s.id, title: 'F01 会话' });
  await c.call('chat.sessions.setModelBinding', { sessionId: s.id, binding });
  return s.id;
}

/** 发一条消息并等回合结束，返回这一回合的事件与假端点收到的请求。 */
async function turn(c: Client, params: Record<string, unknown>) {
  const mark = c.notifications.length;
  const before = hits.length;
  const r = await c.call('chat.prompt', params);
  if (r.error) return { error: r.error.message as string, events: [], requests: hits.slice(before) };
  await waitFor('回合结束', () => c.notifications.slice(mark).some(n => n.method === 'chat.event' && n.params?.sessionId === params.sessionId
    && (n.params.event?.kind === 'turnEnd' || n.params.event?.kind === 'error')));
  const events = c.notifications.slice(mark).filter(n => n.method === 'chat.event' && n.params?.sessionId === params.sessionId).map(n => n.params.event);
  return { error: undefined, events, requests: hits.slice(before) };
}

describe('F01 端到端：配置实例 → 运行时规格 → 实际请求', () => {
  it('验收 1：同一 shared-model 的两个配置各按自己的服务商记录与手动修正；清空、删除、重启后都对', async () => {
    const srv = await boot();
    const c = rpcClient(srv.port, srv.authToken); await c.ready;
    const a = (await c.call('provider.instances.create', { name: '甲', kind: 'openai-compat', baseUrl: api('vendor-a'), modelId: 'shared-model', apiKey: 'test-key', contextWindow: 150_000, maxOutputTokens: 20_000 })).result;
    const b = (await c.call('provider.instances.create', { name: '乙', kind: 'openai-compat', baseUrl: api('vendor-b'), modelId: 'shared-model', apiKey: 'test-key' })).result;

    const ra = (await c.call('provider.runtime.resolve', { id: a.id })).result.runtime;
    const rb = (await c.call('provider.runtime.resolve', { id: b.id })).result.runtime;
    expect(ra).toMatchObject({ endpoint: { class: 'catalog', catalogProviderId: 'vendor-a' }, requestMaxTokens: 20_000, limits: { contextWindow: { value: 150_000, source: 'manual', declared: 200_000 } } });
    expect(rb).toMatchObject({ endpoint: { class: 'catalog', catalogProviderId: 'vendor-b' }, requestMaxTokens: 8_000, limits: { contextWindow: { value: 128_000, source: 'endpoint' } } });

    const sa = await session(c, `provider:${a.id}`);
    const sb = await session(c, `provider:${b.id}`);
    const t1 = await turn(c, { sessionId: sa, text: '你好' });
    expect(t1.requests.map(r => r.url)).toEqual(['/vendor-a/v1/chat/completions']);
    expect(t1.requests[0].body.max_tokens).toBe(20_000);
    expect((await c.call('chat.contextInfo', { sessionId: sa })).result.windowTokens).toBe(150_000);
    const t2 = await turn(c, { sessionId: sb, text: '你好' });
    expect(t2.requests.map(r => r.url)).toEqual(['/vendor-b/v1/chat/completions']);
    expect(t2.requests[0].body.max_tokens).toBe(8_000);
    // F01R：端点记录可信（≤ 窗口的 3/4）时才采用——非手动配置发出的 max_tokens 一定小于窗口
    expect(t2.requests[0].body.max_tokens).toBeLessThan(128_000);
    expect((await c.call('chat.contextInfo', { sessionId: sb })).result.windowTokens).toBe(128_000);

    // 清空 A 的修正：下一条消息就回到 A 自己的服务商记录；B 不受影响；文件里不留旧值
    expect((await c.call('provider.instances.update', { id: a.id, contextWindow: null, maxOutputTokens: null })).error).toBeUndefined();
    const t3 = await turn(c, { sessionId: sa, text: '再来' });
    expect(t3.requests[0].body.max_tokens).toBe(32_000);
    expect(t3.requests[0].body.max_tokens).toBeLessThan(200_000);
    expect((await c.call('chat.contextInfo', { sessionId: sa })).result.windowTokens).toBe(200_000);
    expect((await c.call('chat.contextInfo', { sessionId: sb })).result.windowTokens).toBe(128_000);
    const saved = JSON.parse(readFileSync(join(srv.dataDir, 'providers.json'), 'utf8')).providers.find((p: { id: string }) => p.id === a.id);
    expect(saved).not.toHaveProperty('contextWindow');
    expect(saved).not.toHaveProperty('maxOutputTokens');

    // 不合法的修正当场拒绝、不落库
    expect((await c.call('provider.instances.update', { id: a.id, contextWindow: -5 })).error.message).toContain('正整数');

    // 删除 B：A 不受影响
    await c.call('provider.instances.delete', { id: b.id, confirm: true });
    expect((await c.call('chat.contextInfo', { sessionId: sa })).result.windowTokens).toBe(200_000);
    expect((await c.call('provider.runtime.resolve', { id: b.id })).error.message).toContain('不存在');
    c.close();

    // 重启：从 providers.json 与目录缓存重新解析，结果一致
    await stop?.(); stop = undefined;
    const again = await boot(srv.dataDir);
    const c2 = rpcClient(again.port, again.authToken); await c2.ready;
    const ra2 = (await c2.call('provider.runtime.resolve', { id: a.id })).result.runtime;
    expect(ra2).toMatchObject({ requestMaxTokens: 32_000, limits: { contextWindow: { value: 200_000, source: 'endpoint' } } });
    expect((await c2.call('chat.contextInfo', { sessionId: sa })).result.windowTokens).toBe(200_000);
    const t4 = await turn(c2, { sessionId: sa, text: '重启后' });
    expect(t4.requests[0].body.max_tokens).toBe(32_000);
    c2.close();
  });

  it('验收 2：组内降级，推理参数与输出上限逐槽决定（正向、反向都抓请求体）', async () => {
    const srv = await boot();
    const c = rpcClient(srv.port, srv.authToken); await c.ready;
    const mk = async (name: string, path: string) => (await c.call('provider.instances.create', { name, kind: 'openai-compat', baseUrl: path, modelId: 'shared-model', apiKey: 'test-key' })).result;
    const aOk = await mk('甲', api('vendor-a'));
    const aFail = await mk('甲-限流', `${api('vendor-a')}/fail`);
    const bOk = await mk('乙', api('vendor-b'));
    const bFail = await mk('乙-限流', `${api('vendor-b')}/fail`);

    // 正向：主模型（乙）不支持推理 → 备用（甲）支持，只接受 low/high/max
    const g1 = (await c.call('modelgroup.create', { name: '乙先', memberIds: [bFail.id, aOk.id] })).result;
    const t1 = await turn(c, { sessionId: await session(c, `group:${g1.id}`), text: '想一想', thinkingLevel: 'medium' });
    expect(t1.requests.map(r => r.url)).toEqual(['/vendor-b/v1/fail/chat/completions', '/vendor-a/v1/chat/completions']);
    expect(t1.requests[0].body).not.toHaveProperty('reasoning_effort');
    expect(t1.requests[0].body).not.toHaveProperty('tools');
    expect(t1.requests[0].body.max_tokens).toBe(8_000);
    expect(t1.requests[1].body.reasoning_effort).toBe('low');
    expect(t1.requests[1].body.max_tokens).toBe(32_000);
    expect(t1.requests[1].body.tools.length).toBeGreaterThan(0);
    expect(t1.events.find(e => e.kind === 'fallback')).toMatchObject({ from: '乙-限流(shared-model)', to: '甲(shared-model)' });

    // 反向：主模型（甲）支持推理 → 备用（乙）不支持：备用请求不带推理参数、用自己的输出上限
    const g2 = (await c.call('modelgroup.create', { name: '甲先', memberIds: [aFail.id, bOk.id] })).result;
    const t2 = await turn(c, { sessionId: await session(c, `group:${g2.id}`), text: '想一想', thinkingLevel: 'medium' });
    expect(t2.requests.map(r => r.url)).toEqual(['/vendor-a/v1/fail/chat/completions', '/vendor-b/v1/chat/completions']);
    expect(t2.requests[0].body.reasoning_effort).toBe('low');
    expect(t2.requests[0].body.max_tokens).toBe(32_000);
    expect(t2.requests[1].body).not.toHaveProperty('reasoning_effort');
    expect(t2.requests[1].body).not.toHaveProperty('tools');
    expect(t2.requests[1].body.max_tokens).toBe(8_000);
    expect(t2.events.filter(e => e.kind === 'capability').length).toBeGreaterThan(0);
    c.close();
  });

  it('验收 3：不收图片的配置拒发且不落库；组内按能力切到收图片的成员、不改绑会话', async () => {
    const srv = await boot();
    const c = rpcClient(srv.port, srv.authToken); await c.ready;
    const a = (await c.call('provider.instances.create', { name: '甲', kind: 'openai-compat', baseUrl: api('vendor-a'), modelId: 'shared-model', apiKey: 'test-key' })).result;
    const b = (await c.call('provider.instances.create', { name: '乙', kind: 'openai-compat', baseUrl: api('vendor-b'), modelId: 'shared-model', apiKey: 'test-key' })).result;
    const attach = (sid: string) => {
      const d = join(srv.dataDir, 'sessions', sid, 'attachments');
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'pic.png'), TINY_PNG);
      return ['attachments/pic.png'];
    };

    const sb = await session(c, `provider:${b.id}`);
    const rejected = await turn(c, { sessionId: sb, text: '看图', attachments: attach(sb) });
    expect(rejected.error).toContain('不支持图片输入');
    expect(rejected.error).toContain('消息未发送');
    expect(rejected.requests).toHaveLength(0);
    expect((await c.call('chat.messages.list', { sessionId: sb })).result).toEqual([]);

    const g = (await c.call('modelgroup.create', { name: '乙先', memberIds: [b.id, a.id] })).result;
    const sg = await session(c, `group:${g.id}`);
    const t = await turn(c, { sessionId: sg, text: '看图', attachments: attach(sg) });
    expect(t.requests.map(r => r.url)).toEqual(['/vendor-a/v1/chat/completions']);
    expect(JSON.stringify(t.requests[0].body.messages)).toContain('"type":"image_url"');
    expect(t.events.find(e => e.kind === 'fallback')).toMatchObject({ from: '乙(shared-model)', to: '甲(shared-model)', cause: 'capability' });
    expect(t.events.at(-1)?.kind).toBe('turnEnd');
    const list = (await c.call('chat.sessions.list')).result;
    expect(list.find((x: { id: string }) => x.id === sg)?.modelBinding).toBe(`group:${g.id}`);
    c.close();
  });

  it('验收 3 / 4：设置页草稿解析——视频输入标为不可用并给原因，不带密钥、不向任何端点发请求', async () => {
    const srv = await boot();
    const c = rpcClient(srv.port, srv.authToken); await c.ready;
    const before = hits.length;
    const r = (await c.call('provider.runtime.resolve', { kind: 'gemini', modelId: 'gem-v', contextWindow: 'abc' })).result;
    expect(r.runtime.input.video).toMatchObject({ state: 'unavailable', catalog: { value: true, source: 'endpoint' } });
    expect(r.runtime.input.video.reason).toContain('模型支持视频输入');
    expect(r.runtime.output.video).toMatchObject({ state: 'unavailable', catalog: { value: false } });
    expect(r.runtime.output.text.state).toBe('supported');
    expect(r.runtime.overrides.invalid).toEqual(['contextWindow="abc"']);
    expect(r.status).toMatchObject({ source: 'models.dev', stale: false });
    expect(hits.length).toBe(before);
    expect((await c.call('provider.runtime.resolve', { kind: 'nope', modelId: 'x' })).error.message).toContain('kind');
    c.close();
  });
});

// ───────────────────────── F01R：独立复核确认问题的端到端回归 ─────────────────────────
// 会话约定：每次发送默认用新建并绑定的会话。故障降级会在 turnEnd 把会话改绑到接手的成员，
// 同一会话再发的请求序列就变了；只有要验证「同一会话的下一条」时才复用（用例里写明）。

/** 往会话附件目录放一张图，返回 chat.prompt 的 attachments 入参。 */
function attachPng(dataDir: string, sessionId: string): string[] {
  const d = join(dataDir, 'sessions', sessionId, 'attachments');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'pic.png'), TINY_PNG);
  return ['attachments/pic.png'];
}
const create = async (c: Client, name: string, baseUrl: string, modelId = 'shared-model', extra: Record<string, unknown> = {}) =>
  (await c.call('provider.instances.create', { name, kind: 'openai-compat', baseUrl, modelId, apiKey: 'test-key', ...extra })).result;
const runtimeOf = async (c: Client, id: string) => (await c.call('provider.runtime.resolve', { id })).result.runtime;
const bindingOf = async (c: Client, sessionId: string): Promise<string | undefined> =>
  (await c.call('chat.sessions.list')).result.find((x: { id: string }) => x.id === sessionId)?.modelBinding;
const systemOf = (body: Record<string, any>): string => String(body.messages.find((m: { role: string }) => m.role === 'system')?.content ?? '');
/** E4 用的助手规则与全局记忆（用户内容）：措辞避开 E4 断言「不带工具时不该出现」的那几个词。 */
const ASSISTANT_RULES = '回答先给结论，再给依据。';
const MEMORY_NOTE = '用户习惯：结论用中文写，单位用公制。';
/** 停掉当前的 minisd（一条用例里要重启两次时用；写成函数是因为就地赋 undefined 之后 TS 会把 stop 收窄成 undefined）。 */
async function shutdown(): Promise<void> { await stop?.(); stop = undefined; }

describe('F01R 端到端：复核确认的问题', () => {
  it('E1 目录把输出上限写成等于窗口的配置能发出第一条消息；组内降级后也不带着整窗口的 max_tokens（A1）', async () => {
    const srv = await boot();
    const c = rpcClient(srv.port, srv.authToken); await c.ready;
    const a = await create(c, '甲', `${api('vendor-a')}/strict-262144`, 'ctx-out');
    const rt = await runtimeOf(c, a.id);
    expect(rt.endpoint).toMatchObject({ class: 'catalog', catalogProviderId: 'vendor-a' });
    expect(rt.requestMaxTokens).toBe(65_536);
    expect(rt.limits.maxOutputTokens).toMatchObject({ value: 65_536, source: 'aggregate', declared: 262_144 });
    expect(rt.limits.maxOutputTokens.note).toContain('未采用');

    const sa = await session(c, `provider:${a.id}`);
    const t = await turn(c, { sessionId: sa, text: '你好' });
    expect(t.events.at(-1)).toMatchObject({ kind: 'turnEnd' });
    expect(t.requests.map(r => r.url)).toEqual(['/vendor-a/v1/strict-262144/chat/completions']);
    expect(t.requests[0].body.max_tokens).toBe(65_536);
    expect((await c.call('chat.contextInfo', { sessionId: sa })).result.windowTokens).toBe(262_144);

    const aFail = await create(c, '甲-限流', `${api('vendor-a')}/fail`, 'ctx-out');
    const b = await create(c, '乙', `${api('vendor-b')}/strict-262144`, 'ctx-out');
    const g = (await c.call('modelgroup.create', { name: '甲先', memberIds: [aFail.id, b.id] })).result;
    const tg = await turn(c, { sessionId: await session(c, `group:${g.id}`), text: '你好' });
    expect(tg.requests.map(r => r.url)).toEqual(['/vendor-a/v1/fail/chat/completions', '/vendor-b/v1/strict-262144/chat/completions']);
    expect(tg.requests.map(r => r.body.max_tokens)).toEqual([65_536, 65_536]);
    expect(tg.events.at(-1)).toMatchObject({ kind: 'turnEnd' });
    c.close();
  });

  it('E2 验收 1 补强：删除带修正的配置、带着修正重启、手改文件去掉修正、两个配置同时发，互不污染（A6）', async () => {
    const srv = await boot();
    const c = rpcClient(srv.port, srv.authToken); await c.ready;
    const a = await create(c, '甲', api('vendor-a'), 'shared-model', { contextWindow: 150_000, maxOutputTokens: 20_000, capabilityOverrides: { toolCall: false } });
    const a2 = await create(c, '甲二', api('vendor-a'));
    const b = await create(c, '乙', api('vendor-b'), 'shared-model', { contextWindow: 90_000, maxOutputTokens: 5_000, capabilityOverrides: { toolCall: true } });
    expect(await runtimeOf(c, a.id)).toMatchObject({ requestMaxTokens: 20_000, limits: { contextWindow: { value: 150_000 } }, toolCall: { state: 'unsupported' } });

    // 删除带修正的甲：同端点同型号的甲二不沾它的修正，乙的修正还在；再建一个同名同端点的配置也是干净的
    await c.call('provider.instances.delete', { id: a.id, confirm: true });
    expect(await runtimeOf(c, a2.id)).toMatchObject({ requestMaxTokens: 32_000, limits: { contextWindow: { value: 200_000, source: 'endpoint' } }, toolCall: { state: 'supported' } });
    expect(await runtimeOf(c, b.id)).toMatchObject({ requestMaxTokens: 5_000, limits: { contextWindow: { value: 90_000, source: 'manual' } }, toolCall: { state: 'supported' } });
    const sa2 = await session(c, `provider:${a2.id}`);
    const t1 = await turn(c, { sessionId: sa2, text: '你好' });
    expect(t1.requests[0].body.max_tokens).toBe(32_000);
    expect(t1.requests[0].body.max_tokens).toBeLessThan(200_000);
    expect(t1.requests[0].body.tools.length).toBeGreaterThan(0);
    const reborn = await create(c, '甲', api('vendor-a'));
    const rebornRt = await runtimeOf(c, reborn.id);
    expect(rebornRt).toMatchObject({ requestMaxTokens: 32_000, limits: { contextWindow: { value: 200_000, source: 'endpoint' } }, toolCall: { state: 'supported' } });
    expect(rebornRt.overrides).toEqual({ invalid: [] });
    c.close();

    // 带着乙的修正重启：修正只跟着乙
    await shutdown();
    const second = await boot(srv.dataDir);
    const c2 = rpcClient(second.port, second.authToken); await c2.ready;
    expect(await runtimeOf(c2, a2.id)).toMatchObject({ requestMaxTokens: 32_000, limits: { contextWindow: { value: 200_000 } } });
    const sb = await session(c2, `provider:${b.id}`);
    const t2 = await turn(c2, { sessionId: sb, text: '重启后' });
    expect(t2.requests.map(r => r.url)).toEqual(['/vendor-b/v1/chat/completions']);
    expect(t2.requests[0].body.max_tokens).toBe(5_000);
    expect(t2.requests[0].body.tools.length).toBeGreaterThan(0);
    expect((await c2.call('chat.contextInfo', { sessionId: sb })).result.windowTokens).toBe(90_000);
    const file = join(srv.dataDir, 'providers.json');
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { providers: Record<string, unknown>[] };
    const withOverrides = saved.providers.filter(p => 'contextWindow' in p || 'maxOutputTokens' in p || 'capabilityOverrides' in p).map(p => p.id);
    expect(withOverrides).toEqual([b.id]);

    // 两个配置同时发：各自的 max_tokens 不串（按请求 URL 认）
    const mark = hits.length;
    const sa3 = await session(c2, `provider:${a2.id}`);
    const sb3 = await session(c2, `provider:${b.id}`);
    const both = await Promise.all([turn(c2, { sessionId: sa3, text: '同时' }), turn(c2, { sessionId: sb3, text: '同时' })]);
    expect(both.map(r => r.events.at(-1)?.kind)).toEqual(['turnEnd', 'turnEnd']);
    const sent = hits.slice(mark);
    expect(sent.filter(h => h.url === '/vendor-a/v1/chat/completions').map(h => h.body.max_tokens)).toEqual([32_000]);
    expect(sent.filter(h => h.url === '/vendor-b/v1/chat/completions').map(h => h.body.max_tokens)).toEqual([5_000]);
    c2.close();

    // 手改文件去掉乙的修正再重启：乙回到自己的服务商记录（不带工具）
    await shutdown();
    for (const p of saved.providers) {
      if (p.id === b.id) { delete p.contextWindow; delete p.maxOutputTokens; delete p.capabilityOverrides; }
    }
    writeFileSync(file, JSON.stringify(saved, null, 2));
    const third = await boot(srv.dataDir);
    const c3 = rpcClient(third.port, third.authToken); await c3.ready;
    expect(await runtimeOf(c3, b.id)).toMatchObject({ requestMaxTokens: 8_000, limits: { contextWindow: { value: 128_000, source: 'endpoint' } }, toolCall: { state: 'unsupported' } });
    const t3 = await turn(c3, { sessionId: await session(c3, `provider:${b.id}`), text: '去掉修正后' });
    expect(t3.requests[0].body.max_tokens).toBe(8_000);
    expect(t3.requests[0].body).not.toHaveProperty('tools');
    c3.close();
  });

  it('E3 按能力切换之后接手的成员又故障降级：会话不改绑；纯故障降级仍改绑（B3/D3）', async () => {
    const srv = await boot();
    const c = rpcClient(srv.port, srv.authToken); await c.ready;
    const b = await create(c, '乙', api('vendor-b'));
    const aFail = await create(c, '甲-限流', `${api('vendor-a')}/fail`);
    const a = await create(c, '甲', api('vendor-a'));
    const g = (await c.call('modelgroup.create', { name: '乙先', memberIds: [b.id, aFail.id, a.id] })).result;
    const sg = await session(c, `group:${g.id}`);
    const t = await turn(c, { sessionId: sg, text: '看图', attachments: attachPng(srv.dataDir, sg) });
    expect(t.requests.map(r => r.url)).toEqual(['/vendor-a/v1/fail/chat/completions', '/vendor-a/v1/chat/completions']);
    const hops = t.events.filter(e => e.kind === 'fallback');
    expect(hops.map(e => e.cause)).toEqual(['capability', undefined]);
    expect(t.events.at(-1)?.kind).toBe('turnEnd');
    // 首槽位（乙）一次请求都没发、没有故障：保持组绑定
    expect(await bindingOf(c, sg)).toBe(`group:${g.id}`);
    // 同一会话的下一条纯文本（特意复用会话）：仍从组的首成员起步
    const next = await turn(c, { sessionId: sg, text: '换个话题' });
    expect(next.requests[0].url).toBe('/vendor-b/v1/chat/completions');

    // 对照：第一跳就是故障的降级，维持原规则——改绑到接手的成员
    const g2 = (await c.call('modelgroup.create', { name: '甲先', memberIds: [aFail.id, a.id] })).result;
    const s2 = await session(c, `group:${g2.id}`);
    const t2 = await turn(c, { sessionId: s2, text: '你好' });
    expect(t2.requests.map(r => r.url)).toEqual(['/vendor-a/v1/fail/chat/completions', '/vendor-a/v1/chat/completions']);
    expect(await bindingOf(c, s2)).toBe(`provider:${a.id}`);
    c.close();
  });

  it('E4 不带工具的槽位：系统提示不再声称能读写文件、不带纪律块、桥段落与技能索引；带工具的槽位原样（A5）', async () => {
    // 启动前先放一个技能目录：全新数据目录里没有任何技能，技能索引对两种槽位都是空串，分不出「不带工具时去掉」这一支。
    // minisd 启动时的孤儿回收会把它入库，默认启用
    const srv = await boot(undefined, (dir) => {
      const skill = join(dir, 'skills', 'demo-skill');
      mkdirSync(skill, { recursive: true });
      writeFileSync(join(skill, 'SKILL.md'), '---\nname: demo-skill\ndescription: F01R 回归用的演示技能\n---\n\n# demo-skill\n\n正文不预载。\n');
      // 再放一条全局记忆：记忆注入是用户内容，不是工具指令，不带工具的槽位也要照旧带上
      mkdirSync(join(dir, 'memory'), { recursive: true });
      writeFileSync(join(dir, 'memory', 'GLOBAL.md'), `${MEMORY_NOTE}\n`);
    });
    const c = rpcClient(srv.port, srv.authToken); await c.ready;
    const b = await create(c, '乙', api('vendor-b'));
    const a = await create(c, '甲', api('vendor-a'));
    const sb = await session(c, `provider:${b.id}`);
    const sa = await session(c, `provider:${a.id}`);
    // 助手规则同样是用户内容。套用助手会清掉空会话上的模型绑定（这个助手自己没绑模型、也没勾技能），套完重新绑回去
    const preset = (await c.call('assistants.create', { name: 'F01R 助手', rules: ASSISTANT_RULES })).result as { id: string };
    for (const [sessionId, binding] of [[sb, `provider:${b.id}`], [sa, `provider:${a.id}`]] as const) {
      expect((await c.call('chat.sessions.applyAssistant', { sessionId, assistantId: preset.id })).error, sessionId).toBeUndefined();
      await c.call('chat.sessions.setModelBinding', { sessionId, binding });
      expect(await bindingOf(c, sessionId), sessionId).toBe(binding);
    }
    // 前提：这个技能对两个会话都生效启用
    for (const sessionId of [sb, sa]) {
      expect(((await c.call('skills.list', { sessionId })).result as { id: string }[]).map(s => s.id), sessionId).toEqual(['demo-skill']);
    }
    const tb = await turn(c, { sessionId: sb, text: '把 a.txt 改名为 b.txt' });
    expect(tb.requests).toHaveLength(1);
    expect(tb.requests[0].body).not.toHaveProperty('tools');
    const plain = systemOf(tb.requests[0].body);
    expect(plain).toContain('不支持工具调用');
    // 技能索引要求「先用 file_read 读取其 SKILL.md」：请求里没有工具时不能带
    for (const gone of ['你可以读写文件', '操作纪律', 'MINIS_BRIDGE', '<available_skills>', 'demo-skill', 'file_read']) expect(plain, gone).not.toContain(gone);
    // 去掉的只有上面三段工具指令：助手规则与记忆注入照旧带上（少了它们，换到不带工具的模型就等于悄悄丢了用户的设定）
    const USER_CONTENT = ['<assistant_preset name="F01R 助手">', ASSISTANT_RULES, '背景上下文而非常设指令', MEMORY_NOTE];
    for (const kept of USER_CONTENT) expect(plain, kept).toContain(kept);
    const ta = await turn(c, { sessionId: sa, text: '把 a.txt 改名为 b.txt' });
    expect(ta.requests[0].body.tools.length).toBeGreaterThan(0);
    const full = systemOf(ta.requests[0].body);
    expect(full).toContain('你是 DeskMinis，一个运行在用户 Windows 电脑上的 AI Agent。你可以读写文件、执行 PowerShell 命令来帮助用户完成任务。危险操作会请求用户确认。');
    expect(full).toContain('操作纪律');
    // 带工具的槽位：技能确实装上了，索引照常给
    expect(full).toContain('<available_skills>');
    expect(full).toContain('<name>demo-skill</name>');
    expect(full).toContain('先用 file_read 读取其 SKILL.md');
    // 对照：带工具的槽位上是同一份助手规则与记忆
    for (const kept of USER_CONTENT) expect(full, kept).toContain(kept);
    c.close();
  });

  it('E5 组内降级到中转备用：不带未确认的推理参数并提示；把这个配置的推理手动标为支持后才带（A3）', async () => {
    const srv = await boot();
    const c = rpcClient(srv.port, srv.authToken); await c.ready;
    const bFail = await create(c, '乙-限流', `${api('vendor-b')}/fail`);
    const relay = await create(c, '中转', relayUrl());
    expect((await runtimeOf(c, relay.id)).endpoint.class).toBe('relay');
    const g = (await c.call('modelgroup.create', { name: '乙先', memberIds: [bFail.id, relay.id] })).result;
    const sequence = ['/vendor-b/v1/fail/chat/completions', '/relay/v1/chat/completions'];

    const t1 = await turn(c, { sessionId: await session(c, `group:${g.id}`), text: '想一想', thinkingLevel: 'medium' });
    expect(t1.requests.map(r => r.url)).toEqual(sequence);
    expect(t1.requests[1].body).not.toHaveProperty('reasoning_effort');
    const notices = t1.events.filter(e => e.kind === 'capability').flatMap(e => e.notices as string[]);
    expect(notices.some(n => n.includes('中转') && n.includes('未确认') && n.includes('手动修正'))).toBe(true);

    expect((await c.call('provider.instances.update', { id: relay.id, capabilityOverrides: { reasoning: true } })).error).toBeUndefined();
    const t2 = await turn(c, { sessionId: await session(c, `group:${g.id}`), text: '想一想', thinkingLevel: 'medium' });
    expect(t2.requests.map(r => r.url)).toEqual(sequence);
    expect(t2.requests[1].body.reasoning_effort).toBe('medium');
    c.close();
  });

  it('E6 只有一家否定的型号经中转照常带工具并提示；目录里登记了回环 api 的服务商不认领本机端口（C1/D2、C2）', async () => {
    const srv = await boot();
    const c = rpcClient(srv.port, srv.authToken); await c.ready;
    const solo = await create(c, '中转', relayUrl(), 'solo-neg');
    const t1 = await turn(c, { sessionId: await session(c, `provider:${solo.id}`), text: '你好' });
    expect(t1.requests.map(r => r.url)).toEqual(['/relay/v1/chat/completions']);
    expect(t1.requests[0].body.tools?.length ?? 0).toBeGreaterThan(0);
    expect(t1.events.filter(e => e.kind === 'capability').flatMap(e => e.notices as string[]).some(n => n.includes('工具调用未确认'))).toBe(true);
    expect(t1.events.at(-1)?.kind).toBe('turnEnd');

    const local = await create(c, '本机', loopUrl(), 'loop-only');
    const rt = await runtimeOf(c, local.id);
    expect(rt.endpoint.class).toBe('local');
    expect(rt.endpoint).not.toHaveProperty('catalogProviderId');
    const t2 = await turn(c, { sessionId: await session(c, `provider:${local.id}`), text: '你好' });
    expect(t2.requests.map(r => r.url)).toEqual(['/loop/v1/chat/completions']);
    expect(t2.requests[0].body.tools?.length ?? 0).toBeGreaterThan(0);
    c.close();
  });

  it('E7 端点记录不列文本输出、别家记录列了：消息照常发出（A2）', async () => {
    const srv = await boot();
    const c = rpcClient(srv.port, srv.authToken); await c.ready;
    const a = await create(c, '甲', api('vendor-a'), 'text-dispute');
    const t = await turn(c, { sessionId: await session(c, `provider:${a.id}`), text: '你好' });
    expect(t.error).toBeUndefined();
    expect(t.requests.map(r => r.url)).toEqual(['/vendor-a/v1/chat/completions']);
    expect(t.events.at(-1)?.kind).toBe('turnEnd');
    c.close();
  });
});
