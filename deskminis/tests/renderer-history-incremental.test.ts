/**
 * Q14 · 会话消息的增量读取：真实 store + 真实 RpcClient + 真实引擎（进程内）+ 真实 WebSocket（夹具同 F06 的 E 组）。
 *
 * 断言落在渲染端实际发出的 chat.messages.list 上（参数里带没带 have、应答是完整列表还是 { append }），
 * 以及界面手里的历史与引擎完整列表的逐字节比较。
 *
 * 钉的行为（任务卡的验收 1 到 3，外加尾巴模式与重连）：
 *  H1 本机正常对话的回合结束：没有一次完整读取；取回来的恰好是这一回合落库的消息；
 *  H2 乐观气泡在消息落库后被真实消息换掉，不重复；
 *  H3 同步合并进来一条时间更早的消息：顺序正确（同步通知收到、没收到各一遍）；并进来的排在最后时照样取完整列表；
 *  H4 尾巴模式：每条消息落库只取那之后的；
 *  H5 断线期间回合结束、重连走续传：重连后第一次取历史是完整列表；
 *  H6 线上形态：不带 have 是数组；带 have 接得上是 { append }，接不上是数组。
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  bootEngine, faultProxy, gatedLlm, rendererOn, seg, segs, waitFor, wireClient,
  type BootedEngine, type FaultProxy, type GatedLlm, type GatedStep, type Renderer, type WireClient,
} from './state-sync-fixture';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) { try { await f(); } catch { /* 收尾尽力 */ } }
});

interface Ctx {
  engine: BootedEngine; llm: GatedLlm; proxy: FaultProxy; ref: WireClient;
  /** 渲染端向「主进程」要端口与 token 的那一问：hold() 之后挂着，release() 才答（重连什么时候开始由用例定）。 */
  hold(): void; release(): void;
  info(): Promise<{ port: number; token: string; alive: boolean }>;
}
async function setup(scripts: Record<string, GatedStep[]>): Promise<Ctx> {
  const llm = await gatedLlm(scripts);
  cleanups.push(() => llm.close());
  const engine = await bootEngine({ llm });
  cleanups.push(() => engine.close());
  const proxy = await faultProxy(engine.port);
  cleanups.push(() => proxy.close());
  const ref = wireClient(engine.port, engine.token);
  await ref.ready;
  cleanups.push(() => ref.close());
  let gate: Promise<void> = Promise.resolve();
  let open: () => void = () => undefined;
  cleanups.push(() => open());
  return {
    engine, llm, proxy, ref,
    hold: () => { gate = new Promise<void>(r => { open = r; }); },
    release: () => open(),
    info: async () => { await gate; return { port: proxy.port, token: engine.token, alive: true }; },
  };
}
async function renderer(ctx: Ctx, storage?: Map<string, string>): Promise<Renderer> {
  const r = await rendererOn({ info: ctx.info, ...(storage ? { storage } : {}) });
  cleanups.push(() => r.close());
  return r;
}

type Msg = { id: string; role: string; createdAt: number; parts: { type: string; value: any }[] };
interface ListCall { params: { sessionId: string; have?: { count: number; lastId?: string } }; result?: Msg[] | { append: Msg[] } }
/** 渲染端的 rpc.call 再包一层：记下每次 chat.messages.list 的参数与应答。 */
function spy(r: Renderer): ListCall[] {
  const log: ListCall[] = [];
  const call = r.rpc.call.bind(r.rpc);
  r.rpc.call = ((method: string, params?: unknown) => {
    const p = call(method, params);
    if (method === 'chat.messages.list') {
      const rec: ListCall = { params: JSON.parse(JSON.stringify(params)) as ListCall['params'] };
      log.push(rec);
      p.then(v => { rec.result = v as ListCall['result']; }, () => undefined);
    }
    return p;
  }) as typeof r.rpc.call;
  return log;
}
const isFull = (c: ListCall): boolean => Array.isArray(c.result);
const appended = (c: ListCall): string[] => (Array.isArray(c.result) || !c.result ? [] : c.result.append.map(m => m.id));
const engineList = async (ctx: Ctx, sid: string): Promise<Msg[]> => (await ctx.ref.call('chat.messages.list', { sessionId: sid })).result as Msg[];
const ids = (ms: readonly { id: string }[]): string[] => ms.map(m => m.id);
const texts = (ms: readonly Msg[], role: string): string[] =>
  ms.filter(m => m.role === role).map(m => m.parts.filter(p => p.type === 'text').map(p => String(p.value)).join('')).filter(t => t !== '');
const view = (r: Renderer): Msg[] => r.chat.messages as unknown as Msg[];
const refEnded = (ctx: Ctx, sid: string, n = 1): boolean =>
  ctx.ref.notifications.filter(x => x.method === 'chat.event' && x.params?.sessionId === sid && (x.params.event?.kind === 'turnEnd' || x.params.event?.kind === 'error')).length >= n;
const write = (name: string): { name: string; input: Record<string, unknown> } =>
  ({ name: 'file_write', input: { path: name, content: `${name} 的内容`, tool_title: `写 ${name}` } });

async function newSession(r: Renderer): Promise<string> {
  await r.chat.newSession();
  return r.chat.activeId;
}
/** 发一条、等这一回合结束、等渲染端静下来。 */
async function turn(ctx: Ctx, r: Renderer, text: string, nth: number): Promise<void> {
  const sid = r.chat.activeId;
  await r.chat.send(text);
  await waitFor(`第 ${nth} 个回合在引擎里结束`, () => refEnded(ctx, sid, nth), 30_000);
  await waitFor('界面收尾', () => !r.chat.running && !view(r).some(m => m.id.startsWith('local-')), 20_000);
  await r.quiet(); await ctx.proxy.upstreamIdle();
}
/** 一条别的设备的消息（线上形态），经 sync.push 交给引擎合并——走的是真实的合并与同步通知。 */
async function pushFromPeer(ctx: Ctx, sid: string, id: string, at: number): Promise<void> {
  const message = {
    id, sessionId: sid, role: 'user', partsJson: JSON.stringify([{ type: 'text', value: `别的设备上的一句 ${id}` }]),
    tokenUsageJson: null, reasoningContent: null, streamInterruptCount: 0, sortOrder: 0,
    createdAt: at, updatedAt: at, originDeviceId: 'q14-peer', createdLocallyAt: at,
  };
  const r = await ctx.ref.call('sync.push', { sessionId: sid, payload: { messages: [message], markers: [] } });
  expect(r.error).toBeUndefined();
  await waitFor('合并落库', async () => ids(await engineList(ctx, sid)).includes(id));
}

describe('Q14 H1：正常对话的回合结束不再整会话读取', () => {
  it('两个回合（第二个带两批工具）：回合结束时的读取都带 have，取回来的恰好是这一回合落库的消息；全程没有完整读取', async () => {
    const ctx = await setup({
      S1: [{ text: '第一答' }],
      S2: [{ tools: [write('a.txt')] }, { tools: [write('b.txt')] }, { text: '第二答' }],
    });
    const r = await renderer(ctx);
    const sid = await newSession(r);
    await r.quiet(); await ctx.proxy.upstreamIdle();
    const log = spy(r); // 新建会话时那一次打开（空会话的完整读取）在这之前

    await turn(ctx, r, '[[S1]] 第一问', 1);
    const after1 = await engineList(ctx, sid);
    expect(after1.map(m => m.role)).toEqual(['user', 'assistant']);
    expect(log).toHaveLength(1);
    expect(log[0].params).toEqual({ sessionId: sid, have: { count: 0 } });
    expect([isFull(log[0]), appended(log[0])]).toEqual([false, ids(after1)]);
    expect(JSON.stringify(view(r))).toBe(JSON.stringify(after1));

    await turn(ctx, r, '[[S2]] 第二问', 2);
    const after2 = await engineList(ctx, sid);
    expect(after2.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    expect(log).toHaveLength(2);
    expect(log[1].params).toEqual({ sessionId: sid, have: { count: 2, lastId: after1[1].id } });
    // 取回来的只有第二个回合落库的 6 条，前两条没有再传一遍
    expect([isFull(log[1]), appended(log[1])]).toEqual([false, ids(after2).slice(2)]);
    expect(JSON.stringify(view(r))).toBe(JSON.stringify(after2));
    // 计数：两个回合里完整读取 0 次
    expect(log.filter(c => c.params.have === undefined || isFull(c))).toEqual([]);
    expect(r.unhandled()).toBe(0);
  }, 90_000);
});

describe('Q14 H2：乐观气泡', () => {
  it('回合进行中是「历史 + 一个气泡」；消息落库、回合结束后气泡被真实消息换掉，提问只出现一次', async () => {
    const ctx = await setup({ S1: [{ text: '第一答' }], S3: [{ chunks: segs(2) }] });
    const r = await renderer(ctx);
    const sid = await newSession(r);
    await turn(ctx, r, '[[S1]] 第一问', 1);
    const before = await engineList(ctx, sid);
    const log = spy(r);

    await r.chat.send('[[S3]] 第二问');
    ctx.llm.gate('S3').release(1);
    await waitFor('流出第一段', () => r.chat.streamingText === seg(0));
    // 进行中：前两条是历史，末尾是一个乐观气泡（引擎里真实的那条已经落库，界面要到回合结束才换）
    expect(ids(view(r)).slice(0, 2)).toEqual(ids(before));
    expect(view(r)).toHaveLength(3);
    expect([view(r)[2].role, view(r)[2].id.startsWith('local-')]).toEqual(['user', true]);
    expect(log).toEqual([]);

    ctx.llm.gate('S3').open();
    await waitFor('回合在引擎里结束', () => refEnded(ctx, sid, 2), 20_000);
    await waitFor('界面收尾', () => !r.chat.running && !view(r).some(m => m.id.startsWith('local-')), 20_000);
    await r.quiet(); await ctx.proxy.upstreamIdle();
    const after = await engineList(ctx, sid);
    // 气泡没有被算进「手里有几条」
    expect(log.map(c => c.params)).toEqual([{ sessionId: sid, have: { count: 2, lastId: before[1].id } }]);
    expect(appended(log[0])).toEqual(ids(after).slice(2));
    expect(texts(view(r), 'user')).toEqual(['[[S1]] 第一问', '[[S3]] 第二问']);
    expect(new Set(ids(view(r))).size).toBe(view(r).length);
    expect(JSON.stringify(view(r))).toBe(JSON.stringify(after));
    expect(r.unhandled()).toBe(0);
  }, 90_000);
});

describe('Q14 H3：同步合并进来的消息', () => {
  it('时间更早的一条、同步通知收到了：下一次取历史不带 have，界面里的顺序与引擎相同（它排在最前）', async () => {
    const ctx = await setup({ S1: [{ text: '第一答' }], S4: [{ text: '之后的回答' }] });
    const r = await renderer(ctx);
    const sid = await newSession(r);
    await turn(ctx, r, '[[S1]] 第一问', 1);
    const before = await engineList(ctx, sid);
    const log = spy(r);

    await pushFromPeer(ctx, sid, 'Q14-EARLY', before[0].createdAt - 10);
    await waitFor('界面收到同步通知', () => r.chat.eventNotes.some(n => n.kind === 'synced'));
    await r.chat.open(sid); // 用户点了一下当前会话
    await r.quiet(); await ctx.proxy.upstreamIdle();
    expect(log.map(c => [c.params, isFull(c)])).toEqual([[{ sessionId: sid }, true]]);
    expect(ids(view(r))).toEqual(['Q14-EARLY', ...ids(before)]);
    expect(JSON.stringify(view(r))).toBe(JSON.stringify(await engineList(ctx, sid)));

    // 之后的回合又只取增量，新消息接在后面
    await turn(ctx, r, '[[S4]] 再问一句', 2);
    const after = await engineList(ctx, sid);
    expect(log[1].params).toEqual({ sessionId: sid, have: { count: 3, lastId: before[1].id } });
    expect([isFull(log[1]), appended(log[1])]).toEqual([false, ids(after).slice(3)]);
    expect(JSON.stringify(view(r))).toBe(JSON.stringify(after));
    expect(r.unhandled()).toBe(0);
  }, 90_000);

  it('时间更早的一条、同步通知还在路上时就去取历史：请求带着 have，引擎判断接不上、给完整列表，顺序仍然正确', async () => {
    const ctx = await setup({ S1: [{ text: '第一答' }], S4: [{ text: '之后的回答' }] });
    const r = await renderer(ctx);
    const sid = await newSession(r);
    await turn(ctx, r, '[[S1]] 第一问', 1);
    const before = await engineList(ctx, sid);
    const log = spy(r);

    // 引擎发给界面的帧先扣在代理上：合并已经落库，同步通知还没送到，这时界面去取历史
    //（通知整条丢掉的情形到不了这里：事件流有序号，缺一帧会被发现并重放）
    ctx.proxy.hold();
    await pushFromPeer(ctx, sid, 'Q14-EARLY', before[0].createdAt + (before[1].createdAt - before[0].createdAt) / 2); // 排在两条之间
    expect(r.chat.eventNotes.some(n => n.kind === 'synced')).toBe(false);
    const opening = r.chat.open(sid);
    await ctx.proxy.upstreamIdle(); // 引擎已经答了（应答也扣着）
    ctx.proxy.release();
    await opening;
    await r.quiet(); await ctx.proxy.upstreamIdle();
    expect(log).toHaveLength(1);
    expect(log[0].params).toEqual({ sessionId: sid, have: { count: 2, lastId: before[1].id } });
    expect(isFull(log[0])).toBe(true);
    expect(ids(view(r))).toEqual([before[0].id, 'Q14-EARLY', before[1].id]);
    expect(JSON.stringify(view(r))).toBe(JSON.stringify(await engineList(ctx, sid)));

    await turn(ctx, r, '[[S4]] 再问一句', 2);
    const after = await engineList(ctx, sid);
    expect([log[1].params, isFull(log[1]), appended(log[1])]).toEqual([{ sessionId: sid, have: { count: 3, lastId: before[1].id } }, false, ids(after).slice(3)]);
    expect(JSON.stringify(view(r))).toBe(JSON.stringify(after));
    expect(r.unhandled()).toBe(0);
  }, 90_000);

  it('并进来的一条排在最后（引擎本来接得上）、同步通知收到了：下一次仍取完整列表', async () => {
    const ctx = await setup({ S1: [{ text: '第一答' }] });
    const r = await renderer(ctx);
    const sid = await newSession(r);
    await turn(ctx, r, '[[S1]] 第一问', 1);
    const before = await engineList(ctx, sid);
    const log = spy(r);

    await pushFromPeer(ctx, sid, 'Q14-LATE', before[1].createdAt + 10);
    await waitFor('界面收到同步通知', () => r.chat.eventNotes.some(n => n.kind === 'synced'));
    await r.chat.open(sid);
    await r.quiet(); await ctx.proxy.upstreamIdle();
    expect(log.map(c => [c.params, isFull(c)])).toEqual([[{ sessionId: sid }, true]]);
    expect(ids(view(r))).toEqual([...ids(before), 'Q14-LATE']);
    // 再点一次：这回手里是刚取的完整列表，带 have，没有新消息
    await r.chat.open(sid);
    await r.quiet();
    expect([log[1].params, isFull(log[1]), appended(log[1])]).toEqual([{ sessionId: sid, have: { count: 3, lastId: 'Q14-LATE' } }, false, []]);
    expect(r.unhandled()).toBe(0);
  }, 90_000);
});

describe('Q14 H3：本机的新消息不一定排在末尾', () => {
  it('别的设备的钟快（并进来的消息时间在将来）：下一回合的提问排到它前面；回合结束时引擎判断接不上、给完整列表，顺序正确', async () => {
    const ctx = await setup({ S1: [{ text: '第一答' }], S4: [{ text: '之后的回答' }] });
    const r = await renderer(ctx);
    const sid = await newSession(r);
    await turn(ctx, r, '[[S1]] 第一问', 1);
    await pushFromPeer(ctx, sid, 'Q14-FUTURE', Date.now() / 1000 + 3600);
    await waitFor('界面收到同步通知', () => r.chat.eventNotes.some(n => n.kind === 'synced'));
    await r.chat.open(sid); // 取一次完整列表：手里是 [问, 答, FUTURE]
    await r.quiet(); await ctx.proxy.upstreamIdle();
    expect(ids(view(r)).at(-1)).toBe('Q14-FUTURE');
    const log = spy(r);

    await turn(ctx, r, '[[S4]] 再问一句', 2);
    const after = await engineList(ctx, sid);
    // 提问按墙上时钟落库，排在 FUTURE 之前；回复的时间不早于会话里已有的最大时间，排在它之后
    expect(after.map(m => (m.id === 'Q14-FUTURE' ? 'FUTURE' : m.role))).toEqual(['user', 'assistant', 'user', 'FUTURE', 'assistant']);
    expect(log).toHaveLength(1);
    expect(log[0].params).toEqual({ sessionId: sid, have: { count: 3, lastId: 'Q14-FUTURE' } });
    expect(isFull(log[0])).toBe(true);
    expect(JSON.stringify(view(r))).toBe(JSON.stringify(after));
    expect(r.unhandled()).toBe(0);
  }, 90_000);
});

describe('Q14 H4：尾巴模式', () => {
  it('重载后接上在跑的回合：之后每条消息落库只取它之后的；界面手里的历史始终与引擎一致、没有重复', async () => {
    const ctx = await setup({ S5: [
      { chunks: ['甲'], tools: [write('a.txt')] }, { chunks: ['乙'], tools: [write('b.txt')] }, { chunks: ['丙'] },
    ] });
    const storage = new Map<string, string>();
    const a = await renderer(ctx, storage);
    const sid = await newSession(a);
    await a.chat.send('[[S5]] 写两个文件');
    const gate = ctx.llm.gate('S5');
    gate.release(1);
    await waitFor('第一批工具做完、第二次请求到了模型', () => ctx.llm.hitsOf('S5').length === 2, 20_000);
    await a.close();

    const b = await renderer(ctx, storage);
    const log = spy(b);
    expect([b.chat.activeId, b.chat.joinedTail]).toEqual([sid, true]);
    const atJoin = await engineList(ctx, sid);
    expect(atJoin.map(m => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(ids(view(b))).toEqual(ids(atJoin));
    await b.quiet(); await ctx.proxy.upstreamIdle();
    expect(log).toEqual([]);

    // 放行第二轮：回复（带工具调用）与工具结果先后落库
    gate.release(1);
    await waitFor('第二批工具做完、第三次请求到了模型', () => ctx.llm.hitsOf('S5').length === 3, 20_000);
    await waitFor('界面接上这两条', () => view(b).length === 5);
    await b.quiet(); await ctx.proxy.upstreamIdle();
    const mid = await engineList(ctx, sid);
    expect(JSON.stringify(view(b))).toBe(JSON.stringify(mid));
    expect(log.length).toBeGreaterThanOrEqual(1);
    // 每一次都带 have；没有一次回来的是完整列表；最后生效的那一次从加入时的 3 条或上一次的结果接着取
    expect(log.filter(c => c.params.have === undefined || isFull(c))).toEqual([]);
    for (const c of log) expect([3, 4]).toContain(c.params.have!.count);
    expect(b.chat.streamingText).toBe('');

    const seen = log.length;
    gate.open();
    await waitFor('回合在引擎里结束', () => refEnded(ctx, sid), 20_000);
    await waitFor('界面收尾', () => !b.chat.running && texts(view(b), 'assistant').includes('丙'), 20_000);
    await b.quiet(); await ctx.proxy.upstreamIdle();
    const end = await engineList(ctx, sid);
    expect(end.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    expect(JSON.stringify(view(b))).toBe(JSON.stringify(end));
    expect(new Set(ids(view(b))).size).toBe(6);
    expect(log.length).toBeGreaterThan(seen);
    expect(log.filter(c => c.params.have === undefined || isFull(c))).toEqual([]);
    expect(log.at(-1)!.params.have!.count).toBeGreaterThanOrEqual(5);
    expect(b.unhandled()).toBe(0);
  }, 90_000);
});

describe('Q14 H5：重连', () => {
  it('断线期间回合结束、重连走续传：重连后第一次取历史不带 have（完整列表），最终与引擎一致', async () => {
    const ctx = await setup({ S6: [{ chunks: ['第一轮甲', '第一轮乙'], tools: [write('e.txt')] }, { chunks: segs(3) }] });
    const b = await renderer(ctx);
    const sid = await newSession(b);
    await b.chat.send('[[S6]] 先写文件再回答');
    const gate = ctx.llm.gate('S6');
    gate.release(3);
    await waitFor('流到第二轮的第一段', () => b.chat.streamingText.endsWith(seg(0)), 20_000);
    await b.quiet(); await ctx.proxy.upstreamIdle();
    const log = spy(b);
    const tracker = (b.rpc as unknown as { tracker: { stats: { resumes: number } } }).tracker;
    const resumesBefore = tracker.stats.resumes;

    ctx.hold();
    ctx.proxy.cut();
    await waitFor('进入重连', () => b.chat.connection === 'reconnecting');
    gate.open();
    await waitFor('回合在引擎里结束', () => refEnded(ctx, sid), 20_000);
    ctx.release();
    await waitFor('重连并同步完成', () => b.chat.connection === 'ok' && b.chat.linkGeneration >= 1, 15_000);
    const end = await engineList(ctx, sid);
    await waitFor('历史收敛到库', () => !b.chat.running && ids(view(b)).join() === ids(end).join(), 15_000);
    await b.quiet(); await ctx.proxy.upstreamIdle();

    expect(tracker.stats.resumes).toBeGreaterThan(resumesBefore); // 走的是续传：回放的 turnEnd 会去取历史
    expect(log.length).toBeGreaterThan(0);
    expect([log[0].params, isFull(log[0])]).toEqual([{ sessionId: sid }, true]);
    expect(JSON.stringify(view(b))).toBe(JSON.stringify(end));
    expect(b.unhandled()).toBe(0);
  }, 90_000);
});

describe('Q14 H5：重连带回来的快照之后', () => {
  it('空闲时断线重连：历史由快照整份带回来（这就是那一次完整重取），之后同一个会话再取历史只取增量', async () => {
    const ctx = await setup({ S1: [{ text: '第一答' }] });
    const r = await renderer(ctx);
    const sid = await newSession(r);
    await turn(ctx, r, '[[S1]] 第一问', 1);
    const before = await engineList(ctx, sid);
    const log = spy(r);
    const tracker = (r.rpc as unknown as { tracker: { stats: { snapshots: number } } }).tracker;
    const snapshotsBefore = tracker.stats.snapshots;

    ctx.proxy.cut();
    await waitFor('重连并同步完成', () => r.chat.connection === 'ok' && r.chat.linkGeneration >= 1, 15_000);
    await waitFor('带会话的快照装进来了', () => tracker.stats.snapshots > snapshotsBefore, 15_000);
    await r.quiet(); await ctx.proxy.upstreamIdle();
    expect(JSON.stringify(view(r))).toBe(JSON.stringify(before));
    // 重连这一路没有另发 chat.messages.list：完整的历史是快照带回来的
    expect(log).toEqual([]);

    await r.chat.open(sid);
    await r.quiet(); await ctx.proxy.upstreamIdle();
    expect([log[0].params, isFull(log[0]), appended(log[0])]).toEqual([{ sessionId: sid, have: { count: 2, lastId: before[1].id } }, false, []]);
    expect(r.unhandled()).toBe(0);
  }, 90_000);
});

describe('Q14 H6：chat.messages.list 的线上形态', () => {
  it('不带 have 是数组；带 have 接得上是 { append }，接不上、认不出来都是完整的数组；会话 id 照旧校验', async () => {
    const ctx = await setup({ S1: [{ text: '第一答' }], S4: [{ text: '之后的回答' }] });
    const r = await renderer(ctx);
    const sid = await newSession(r);
    await turn(ctx, r, '[[S1]] 第一问', 1);
    await turn(ctx, r, '[[S4]] 第二问', 2);
    const list = async (extra?: Record<string, unknown>): Promise<any> => (await ctx.ref.call('chat.messages.list', { sessionId: sid, ...extra })).result;
    const full = await list() as Msg[];
    expect(Array.isArray(full)).toBe(true);
    expect(full).toHaveLength(4);

    expect(await list({ have: { count: 4, lastId: full[3].id } })).toEqual({ append: [] });
    expect(await list({ have: { count: 1, lastId: full[0].id } })).toEqual({ append: full.slice(1) });
    expect(await list({ have: { count: 0 } })).toEqual({ append: full });
    // 接不上、认不出来：与不带 have 时逐字节相同
    for (const have of [{ count: 3, lastId: full[3].id }, { count: 4, lastId: 'NOPE' }, { count: 4 }, null, 'x', 7, [], {}]) {
      expect(JSON.stringify(await list({ have })), JSON.stringify(have)).toBe(JSON.stringify(full));
    }
    // 会话 id 的校验不因为带了 have 而跳过
    const bad = await ctx.ref.call('chat.messages.list', { sessionId: '../x', have: { count: 0 } });
    const plain = await ctx.ref.call('chat.messages.list', { sessionId: '../x' });
    expect(bad.error?.message).toBeTruthy();
    expect(bad.error?.message).toBe(plain.error?.message);
  }, 90_000);
});
