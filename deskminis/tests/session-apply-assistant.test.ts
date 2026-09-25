/**
 * W2b-4 · 空会话套用 / 解绑助手：chat.sessions.applyAssistant（设计稿 §2「渲染端」；renderer.md W2b-welcome；cross.md S22）。
 *
 * 欢迎页的谎：NavRail「新建会话」得到的是一个**已存在的空会话**，欢迎页却承诺「已选 X——直接输入即以该预设开始」，
 * 发送走的是「已有会话」那条路，助手从没被套上。后端此前没有任何 RPC 能给已有会话套用助手（只有 create 带 assistantId）。
 *
 * 语义：把这个空会话重置成 chat.sessions.create({assistantId}) 会得到的样子——
 * 助手 id、模型绑定、技能覆盖三件一起重置（先清覆盖再按快照写），标题只在还是默认值时才改成助手名；
 * 有消息的会话与运行中的会话一律拒绝（历史已按旧预设跑过，半途换预设等于改写过去）。
 *
 * 用真 minisd + ws 客户端；最后一例用本地假 OpenAI 端点抓请求体，证明套用之后第一条消息真的带着助手预设、
 * 发到助手绑定的那个模型——源码守卫证明不了这一层。
 */
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMinisd } from '../src/minisd/index';

let stop: (() => Promise<void>) | undefined;
const savedFake = process.env.DESKMINIS_FAKE_PROVIDER;
afterEach(async () => {
  await stop?.(); stop = undefined;
  if (savedFake === undefined) delete process.env.DESKMINIS_FAKE_PROVIDER; else process.env.DESKMINIS_FAKE_PROVIDER = savedFake;
});

const skillMd = (name: string): string => `---\nname: ${name}\ndescription: 演示技能 ${name}\nversion: 1.0.0\n---\n# ${name}\n正文。\n`;

/** 数据根里预铺两个技能目录：启动时的孤儿回收会把它们入库（全局启用）。 */
async function boot(opts: { fake: boolean }) {
  const dataDir = mkdtempSync(join(tmpdir(), 'dm-apply-asst-'));
  for (const id of ['alpha', 'beta']) {
    mkdirSync(join(dataDir, 'skills', id), { recursive: true });
    writeFileSync(join(dataDir, 'skills', id, 'SKILL.md'), skillMd(id));
  }
  process.env.DESKMINIS_TEST = '1';
  if (opts.fake) process.env.DESKMINIS_FAKE_PROVIDER = '1'; else delete process.env.DESKMINIS_FAKE_PROVIDER;
  const srv = await startMinisd({ dataDir, host: '127.0.0.1', port: 0 });
  stop = srv.close;
  return srv;
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

async function waitFor(what: string, cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise(r => setTimeout(r, 10));
  }
}

async function connect(opts: { fake: boolean }): Promise<Client> {
  const { port, authToken } = await boot(opts);
  const c = rpcClient(port, authToken); await c.ready;
  return c;
}
const ok = async (c: Client, method: string, params?: unknown): Promise<any> => {
  const r = await c.call(method, params);
  expect(r.error, `${method} 不该报错：${JSON.stringify(r.error)}`).toBeUndefined();
  return r.result;
};
const session = async (c: Client, id: string) => ((await ok(c, 'chat.sessions.list')) as any[]).find(s => s.id === id);
const enabledSkills = async (c: Client, id: string): Promise<string[]> =>
  ((await ok(c, 'skills.list', { sessionId: id })) as { id: string }[]).map(s => s.id).sort();
const changedSince = (c: Client, mark: number): boolean =>
  c.notifications.slice(mark).some(n => n.method === 'chat.sessions.changed');

/** X：绑模型、只勾 alpha；Y：不绑模型、不勾技能（技能跟随全局）。 */
async function seedAssistants(c: Client) {
  const x = await ok(c, 'assistants.create', { name: '写手甲', avatar: '✍️', rules: '你是写手甲。', modelBinding: 'provider:PX', skillIds: ['alpha'] });
  const y = await ok(c, 'assistants.create', { name: '助手乙', avatar: '🧪', rules: '你是助手乙。' });
  return { x, y };
}

describe('chat.sessions.applyAssistant — 空会话套用助手', () => {
  it('空会话套用 X：结果与 create({assistantId:X}) 建出的会话一致（助手 id / 模型绑定 / 技能快照 / 标题），并广播 chat.sessions.changed', async () => {
    const c = await connect({ fake: true });
    const { x } = await seedAssistants(c);
    const ref = await ok(c, 'chat.sessions.create', { assistantId: x.id });
    const s = await ok(c, 'chat.sessions.create', {});
    expect(s.title).toBe('新会话');

    const mark = c.notifications.length;
    const r = await ok(c, 'chat.sessions.applyAssistant', { sessionId: s.id, assistantId: x.id });
    expect(r.id).toBe(s.id);

    const got = await session(c, s.id);
    const want = await session(c, ref.id);
    expect(got.assistantId).toBe(x.id);
    expect(got.modelBinding).toBe('provider:PX');
    expect(got.title).toBe('写手甲');
    expect({ a: got.assistantId, b: got.modelBinding, t: got.title }).toEqual({ a: want.assistantId, b: want.modelBinding, t: want.title });
    expect(await enabledSkills(c, s.id)).toEqual(['alpha']);                 // 快照：勾的写 1、其余已装的写 0
    expect(await enabledSkills(c, s.id)).toEqual(await enabledSkills(c, ref.id));
    await waitFor('chat.sessions.changed 广播', () => changedSince(c, mark));
    c.close();
  });

  it('替换：已绑 X 的空会话（create 路径，标题是 X 的名字）套用 Y → 绑定与技能覆盖全换成 Y 的，X 的不残留；标题跟着换成 Y', async () => {
    const c = await connect({ fake: true });
    const { x, y } = await seedAssistants(c);
    const s = await ok(c, 'chat.sessions.create', { assistantId: x.id });
    expect(await enabledSkills(c, s.id)).toEqual(['alpha']);

    await ok(c, 'chat.sessions.applyAssistant', { sessionId: s.id, assistantId: y.id });
    const got = await session(c, s.id);
    expect(got.assistantId).toBe(y.id);
    // Y 不绑模型：X 留下的 provider:PX 必须清掉，否则胶囊说「默认」、请求却发给 X 的模型
    expect(got.modelBinding).toBeUndefined();
    // Y 不勾技能：覆盖全清、回到全局（alpha、beta 都启用）；不清的话 beta 会被 X 的快照继续关着
    expect(await enabledSkills(c, s.id)).toEqual(['alpha', 'beta']);
    // 标题是 X 的名字 = create 路径给的默认名，不是用户起的：跟着换成 Y，与 create({assistantId:Y}) 一致
    expect(got.title).toBe('助手乙');
    c.close();
  });

  it('空会话上手动设过模型绑定：套用助手时被助手的绑定覆盖（发送前胶囊已预览出这个结果）', async () => {
    const c = await connect({ fake: true });
    const { x, y } = await seedAssistants(c);
    const s1 = await ok(c, 'chat.sessions.create', {});
    await ok(c, 'chat.sessions.setModelBinding', { sessionId: s1.id, binding: 'provider:MANUAL' });
    await ok(c, 'chat.sessions.applyAssistant', { sessionId: s1.id, assistantId: x.id });
    expect((await session(c, s1.id)).modelBinding).toBe('provider:PX');

    const s2 = await ok(c, 'chat.sessions.create', {});
    await ok(c, 'chat.sessions.setModelBinding', { sessionId: s2.id, binding: 'provider:MANUAL' });
    await ok(c, 'chat.sessions.applyAssistant', { sessionId: s2.id, assistantId: y.id });
    expect((await session(c, s2.id)).modelBinding).toBeUndefined();
    c.close();
  });

  it('解绑（assistantId 传空串）：清助手 id、模型绑定与技能覆盖；标题若是原助手的名字就回到「新会话」；广播 changed', async () => {
    const c = await connect({ fake: true });
    const { x } = await seedAssistants(c);
    const s = await ok(c, 'chat.sessions.create', { assistantId: x.id });
    expect((await session(c, s.id)).title).toBe('写手甲');

    const mark = c.notifications.length;
    await ok(c, 'chat.sessions.applyAssistant', { sessionId: s.id, assistantId: '' });
    const got = await session(c, s.id);
    expect(got.assistantId).toBeUndefined();
    expect(got.modelBinding).toBeUndefined();
    expect(await enabledSkills(c, s.id)).toEqual(['alpha', 'beta']);
    // 与 create({}) 一致：标题回到默认值，首回合结束后照常自动命名
    expect(got.title).toBe('新会话');
    await waitFor('chat.sessions.changed 广播', () => changedSince(c, mark));
    c.close();
  });

  it('用户自己起的标题不动：套用、替换、解绑都只在标题还是默认值（或原助手名）时改', async () => {
    const c = await connect({ fake: true });
    const { x, y } = await seedAssistants(c);
    const s = await ok(c, 'chat.sessions.create', {});
    await ok(c, 'chat.sessions.rename', { sessionId: s.id, title: '周报' });
    await ok(c, 'chat.sessions.applyAssistant', { sessionId: s.id, assistantId: x.id });
    expect((await session(c, s.id)).title).toBe('周报');
    await ok(c, 'chat.sessions.applyAssistant', { sessionId: s.id, assistantId: y.id });
    expect((await session(c, s.id)).title).toBe('周报');
    await ok(c, 'chat.sessions.applyAssistant', { sessionId: s.id, assistantId: '' });
    expect((await session(c, s.id)).title).toBe('周报');
    c.close();
  });

  it('有消息的会话拒绝，且什么都不改（历史是按旧预设跑出来的，半途换预设等于改写过去）', async () => {
    const c = await connect({ fake: true });
    const { x } = await seedAssistants(c);
    const s = await ok(c, 'chat.sessions.create', {});
    const mark = c.notifications.length;
    await ok(c, 'chat.prompt', { sessionId: s.id, providerId: '__fake__', text: '你好' });
    await waitFor('回合结束', () => c.notifications.slice(mark).some(n => n.method === 'chat.event' && (n.params?.event?.kind === 'turnEnd' || n.params?.event?.kind === 'error')));
    await new Promise(r => setTimeout(r, 50)); // run 的 finally 摘 inFlight 在最后一个事件之后

    const r = await c.call('chat.sessions.applyAssistant', { sessionId: s.id, assistantId: x.id });
    expect(r.error?.message ?? '').toMatch(/已有消息/);
    const got = await session(c, s.id);
    expect(got.assistantId).toBeUndefined();
    expect(got.modelBinding).toBeUndefined();
    expect(await enabledSkills(c, s.id)).toEqual(['alpha', 'beta']);
    c.close();
  });

  it('运行中的会话拒绝（回合挂在权限卡上时）', async () => {
    const c = await connect({ fake: true });
    const { x } = await seedAssistants(c);
    const s = await ok(c, 'chat.sessions.create', {});
    const mark = c.notifications.length;
    // web_fetch 一律过卡（askOnce），Linux 上也能把回合挂住
    const script = `__tool__ web_fetch ${JSON.stringify({ url: 'http://127.0.0.1:9/x', tool_title: '抓取' })}`;
    await ok(c, 'chat.prompt', { sessionId: s.id, providerId: '__fake__', text: script });
    await waitFor('权限卡', () => c.notifications.slice(mark).some(n => n.method === 'permission.request'));

    const r = await c.call('chat.sessions.applyAssistant', { sessionId: s.id, assistantId: x.id });
    expect(r.error?.message ?? '').toMatch(/运行中/);
    expect((await session(c, s.id)).assistantId).toBeUndefined();

    const req = c.notifications.slice(mark).find(n => n.method === 'permission.request')!;
    await ok(c, 'permission.respond', { requestId: req.params.requestId, decision: 'deny' });
    await waitFor('回合结束', () => c.notifications.slice(mark).some(n => n.method === 'chat.event' && (n.params?.event?.kind === 'turnEnd' || n.params?.event?.kind === 'error')));
    await new Promise(r2 => setTimeout(r2, 50));
    c.close();
  });

  it('参数校验：助手不存在 / 会话不存在 / assistantId 不是字符串，一律拒绝且不改会话', async () => {
    const c = await connect({ fake: true });
    const s = await ok(c, 'chat.sessions.create', {});
    const r1 = await c.call('chat.sessions.applyAssistant', { sessionId: s.id, assistantId: 'NOPE' });
    expect(r1.error?.message ?? '').toMatch(/助手不存在/);
    const r2 = await c.call('chat.sessions.applyAssistant', { sessionId: '00000000-0000-0000-0000-000000000000', assistantId: '' });
    expect(r2.error).toBeDefined();
    const r3 = await c.call('chat.sessions.applyAssistant', { sessionId: s.id });
    expect(r3.error).toBeDefined();
    const got = await session(c, s.id);
    expect(got.assistantId).toBeUndefined();
    expect(got.title).toBe('新会话');
    c.close();
  });
});

describe('chat.sessions.applyAssistant — 套用之后第一条消息真的带着预设（真 provider + 本地假端点抓请求体）', () => {
  let mock: Server;
  let mockPort = 0;
  const bodies: { url: string; body: any }[] = [];
  beforeAll(async () => {
    mock = createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => { raw += String(d); });
      req.on('end', () => {
        try { bodies.push({ url: String(req.url), body: JSON.parse(raw) }); } catch { bodies.push({ url: String(req.url), body: null }); }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '好的' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
        res.end('data: [DONE]\n\n');
      });
    });
    await new Promise<void>(r => mock.listen(0, '127.0.0.1', () => r()));
    mockPort = (mock.address() as { port: number }).port;
  });
  afterAll(() => new Promise<void>(r => mock.close(() => r())));

  it('默认模型是 A、助手绑 B：空会话套用后发消息 → 请求打到 B，系统提示含 <assistant_preset name="写手甲">', async () => {
    bodies.length = 0;
    const c = await connect({ fake: false });
    const pa = await ok(c, 'provider.instances.create', { name: '默认甲', kind: 'ollama', baseUrl: `http://127.0.0.1:${mockPort}/a/v1`, modelId: 'mock-a' });
    const pb = await ok(c, 'provider.instances.create', { name: '绑定乙', kind: 'ollama', baseUrl: `http://127.0.0.1:${mockPort}/b/v1`, modelId: 'mock-b' });
    await ok(c, 'provider.setDefault', { id: pa.id });
    const x = await ok(c, 'assistants.create', { name: '写手甲', rules: '你是写手甲，只写短句。', modelBinding: `provider:${pb.id}` });
    const s = await ok(c, 'chat.sessions.create', {});

    await ok(c, 'chat.sessions.applyAssistant', { sessionId: s.id, assistantId: x.id });
    const mark = c.notifications.length;
    await ok(c, 'chat.prompt', { sessionId: s.id, text: '写一句问候' });
    await waitFor('回合结束', () => c.notifications.slice(mark).some(n => n.method === 'chat.event' && (n.params?.event?.kind === 'turnEnd' || n.params?.event?.kind === 'error')), 15000);

    const first = bodies.find(b => b.url.includes('/chat/completions'));
    expect(first, '应当有一次 chat/completions 请求').toBeTruthy();
    expect(first!.url.startsWith('/b/'), `请求应打到助手绑定的模型，实际 ${first!.url}`).toBe(true);
    expect(first!.body.model).toBe('mock-b');
    const sys = (first!.body.messages as { role: string; content: unknown }[]).find(m => m.role === 'system');
    expect(String(sys?.content ?? '')).toContain('<assistant_preset name="写手甲">');
    expect(String(sys?.content ?? '')).toContain('你是写手甲，只写短句。');
    await new Promise(r => setTimeout(r, 100)); // 首回合后的自动命名是 fire-and-forget，让它收完尾再关库
    c.close();
  });
});
