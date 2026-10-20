/**
 * F06 E 组：真实 store + 真实 RpcClient + 真实引擎（进程内）+ 真实 WebSocket，中间夹一个故障代理。
 *
 * 「重载」= 关掉旧的渲染端实例、用同一个 sessionStorage 再装一份全新的模块实例。断线、吞应答、丢请求都发生在代理上，
 * 产品代码里没有故障开关。断言落在状态与副作用上：模型端点被请求了几次、库里几条消息、代理转发了几条上行帧、文件写了几次。
 *
 * 钉的行为：
 *  E1 流式中途重载：回到原会话、在跑、已流出的正文还在，之后接着长，最终只出现一次、只请求一次模型；
 *  E2 审批中重载：同一个 requestId 的卡回来，能答复，工具只执行一次；
 *  E3 发送的应答被吞：重连后不重发（上行 chat.prompt 恰 1 条），乐观气泡换成真实消息，运行条在；
 *  E4 发送没到引擎：不自动重发（上行 0 条）、只留「没有送达」一条、气泡还在；点重试沿用原 promptId；续传与快照各一遍；
 *  E5 / E6 批准的应答被吞 / 批准没到引擎：分别恰 1 条与 0 条上行帧，界面如实交代；
 *  E7 两个窗口看同一个 run 与权限卡，其中一个掐断重连后两边一致；
 *  E8 断线期间回合结束（续传）：历史与库一致、不在跑、缓冲为空；没有广播的域也是新的；再发一条，上一条回复仍在；
 *  E9 尾巴模式下断线期间回合结束：同上，且正文在「历史 + 缓冲」里任何采样时刻只出现一次；
 *  E10 起跑期间（连 MCP）重载：不点亮，探测到它起跑后点亮；起跑失败则始终不点亮；
 *  E11 换会话的 open() 在途时断线：重连后是新会话的历史，没有旧会话的半截；
 *  E12 断线期间当前会话被删（另有一个会话）：续传时落到另一个会话（同在线时收到生命周期广播），快照时落到欢迎页。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readDb } from './run-ledger-fixture';
import {
  bootEngine, faultProxy, gatedLlm, hangingMcp, rendererOn, seg, segs, skillFile, skillWriteInput, waitFor, wireClient,
  type BootOpts, type BootedEngine, type FaultProxy, type GatedLlm, type GatedStep, type Renderer, type WireClient,
} from './state-sync-fixture';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) { try { await f(); } catch { /* 收尾尽力 */ } }
});

interface Ctx {
  engine: BootedEngine; llm: GatedLlm; proxy: FaultProxy;
  /** 直连引擎的参照客户端（也用来在渲染端断线期间改东西）。 */
  ref: WireClient;
  /** 渲染端向「主进程」要端口与 token 的那一问：hold() 之后挂着，release() 才答——重连什么时候开始由用例定，不靠退避时长猜。 */
  hold(): void; release(): void;
}

async function setup(scripts: Record<string, GatedStep[]>, opts: BootOpts = {}): Promise<Ctx> {
  const llm = await gatedLlm(scripts);
  cleanups.push(() => llm.close());
  const engine = await bootEngine({ llm, ...opts });
  cleanups.push(() => engine.close());
  const proxy = await faultProxy(engine.port);
  cleanups.push(() => proxy.close());
  const ref = wireClient(engine.port, engine.token);
  await ref.ready;
  cleanups.push(() => ref.close());
  let gate: Promise<void> = Promise.resolve();
  let open: () => void = () => undefined;
  const ctx: Ctx & { info: () => Promise<{ port: number; token: string; alive: boolean }> } = {
    engine, llm, proxy, ref,
    hold: () => { gate = new Promise<void>(r => { open = r; }); },
    release: () => open(),
    info: async () => { await gate; return { port: proxy.port, token: engine.token, alive: true }; },
  };
  cleanups.push(() => open());
  return ctx;
}

async function renderer(ctx: Ctx, o: { storage?: Map<string, string>; policy?: Record<string, unknown> } = {}): Promise<Renderer> {
  const r = await rendererOn({ info: (ctx as unknown as { info: () => Promise<{ port: number; token: string; alive: boolean }> }).info, ...o });
  cleanups.push(() => r.close());
  return r;
}

type Msg = { id: string; role: string; parts: { type: string; value: any }[] };
const texts = (msgs: readonly Msg[], role: string): string[] =>
  msgs.filter(m => m.role === role).map(m => m.parts.filter(p => p.type === 'text').map(p => String(p.value)).join('')).filter(t => t !== '');
const stored = (dataDir: string, sessionId: string): Msg[] =>
  readDb<{ id: string; role: string; parts_json: string }>(dataDir, 'SELECT id, role, parts_json FROM messages WHERE session_id=? ORDER BY created_at ASC, id ASC', sessionId)
    .map(r => ({ id: r.id, role: r.role, parts: JSON.parse(r.parts_json) as Msg['parts'] }));
const ids = (msgs: readonly { id: string }[]): string[] => msgs.map(m => m.id);
const runs = (dataDir: string, sessionId: string): { state: string; stop_reason: string | null; prompt_id: string | null }[] =>
  readDb(dataDir, 'SELECT state, stop_reason, prompt_id FROM agent_runs WHERE session_id=? ORDER BY generation', sessionId);
const notes = (r: Renderer): string[] => r.chat.eventNotes.map(n => String(n.short ?? n.detail ?? ''));
const refEnded = (ctx: Ctx, sessionId: string): boolean =>
  ctx.ref.notifications.some(n => n.method === 'chat.event' && n.params?.sessionId === sessionId && (n.params.event?.kind === 'turnEnd' || n.params.event?.kind === 'error'));
/** 对话流里此刻能看到的助手正文：历史里的 + 实时区的缓冲。 */
const flow = (r: Renderer): string => texts(r.chat.messages as unknown as Msg[], 'assistant').join('') + r.chat.streamingText;
const occurrences = (hay: string, needle: string): number => hay.split(needle).length - 1;
const stats = (r: Renderer): { resumes: number; snapshots: number } => (r.rpc as unknown as { tracker: { stats: { resumes: number; snapshots: number } } }).tracker.stats;
/** 渲染端经过一次完整的「断线 → 重连 → 同步」之后兑现。 */
const reconnected = (r: Renderer, generation: number): Promise<void> =>
  waitFor('渲染端重连并同步完成', () => r.chat.connection === 'ok' && r.chat.linkGeneration >= generation, 15_000);

async function newSession(r: Renderer): Promise<string> {
  await r.chat.newSession();
  return r.chat.activeId;
}

describe('F06 E 组：重载', () => {
  it('E1 流式中途重载：回到原会话、在跑、已流出的正文还在；放闸后接着长，最终正文只出现一次、模型只被请求一次', async () => {
    const ctx = await setup({ S1: [{ chunks: segs(5) }] });
    const storage = new Map<string, string>();
    const a = await renderer(ctx, { storage });
    const sid = await newSession(a);
    await a.chat.send('[[S1]] 分五段');
    const gate = ctx.llm.gate('S1');
    gate.release(2);
    await waitFor('重载前流出前两段', () => a.chat.streamingText === seg(0) + seg(1));
    await a.close(); // 重载：旧页面没了（先等它静下来再关），新页面什么都不记得

    const b = await renderer(ctx, { storage });
    expect(b.chat.activeId).toBe(sid);
    expect([b.chat.running, b.chat.runningSessions]).toEqual([true, [sid]]);
    expect(b.chat.joinedTail).toBe(true);
    expect(b.chat.midRun).toBe(false);
    expect(texts(b.chat.messages as unknown as Msg[], 'user')).toEqual(['[[S1]] 分五段']);
    expect(b.chat.streamingText).toBe(seg(0) + seg(1));
    gate.release(1);
    await waitFor('重载后接着长', () => b.chat.streamingText === seg(0) + seg(1) + seg(2));
    gate.open();
    await waitFor('回合结束并换成历史', () => !b.chat.running && b.chat.streamingText === '' && texts(b.chat.messages as unknown as Msg[], 'assistant').length === 1, 20_000);
    const full = segs(5).join('');
    expect(texts(b.chat.messages as unknown as Msg[], 'assistant')).toEqual([full]);
    expect(ids(b.chat.messages)).toEqual(ids(stored(ctx.engine.dataDir, sid)));
    expect(b.chat.runningSessions).toEqual([]);
    // 不重复执行：模型端点对这个剧本只被请求一次；库里 user 1 条、assistant 1 条、run 1 行
    expect(ctx.llm.hitsOf('S1')).toHaveLength(1);
    expect(stored(ctx.engine.dataDir, sid).map(m => m.role)).toEqual(['user', 'assistant']);
    expect(runs(ctx.engine.dataDir, sid).map(r => r.state)).toEqual(['completed']);
    expect(ctx.proxy.countUp('chat.prompt')).toBe(1);
    expect(b.unhandled()).toBe(0);
  }, 60_000);

  it('E2 审批中重载：同一个 requestId 的卡回来；答复生效，工具恰好执行一次', async () => {
    const ctx = await setup({ S2: [{ tools: [{ name: 'file_write', input: skillWriteInput('e2.txt', 'E2 的内容') }] }, { text: 'E2 完成' }] });
    const file = skillFile(ctx.engine.dataDir, 'e2.txt');
    const storage = new Map<string, string>();
    const a = await renderer(ctx, { storage });
    const sid = await newSession(a);
    await a.chat.send('[[S2]] 写技能目录');
    await waitFor('重载前卡片出现', () => a.chat.pendingPerms.length === 1, 20_000);
    const before = { ...a.chat.pendingPerms[0] };
    await a.close();

    const b = await renderer(ctx, { storage });
    expect(b.chat.activeId).toBe(sid);
    expect(b.chat.pendingPerms.map(p => p.requestId)).toEqual([before.requestId]);
    expect({ ...b.chat.pendingPerms[0], deadlineMs: 0 }).toEqual({ ...before, deadlineMs: 0 });
    expect([b.chat.running, b.chat.runningSessions]).toEqual([true, [sid]]);
    expect(existsSync(file)).toBe(false);
    await b.chat.respondPerm(before.requestId, 'allow-once');
    await waitFor('回合结束', () => !b.chat.running && texts(b.chat.messages as unknown as Msg[], 'assistant').includes('E2 完成'), 20_000);
    expect(readFileSync(file, 'utf8')).toBe('E2 的内容');
    expect(readDb(ctx.engine.dataDir, 'SELECT state, started FROM tool_executions WHERE session_id=?', sid)).toEqual([{ state: 'completed', started: 1 }]);
    expect(texts(stored(ctx.engine.dataDir, sid), 'user')).toEqual(['[[S2]] 写技能目录']);
    expect(ctx.llm.hitsOf('S2')).toHaveLength(2);
    expect(notes(b)).toEqual([]);
    expect(b.unhandled()).toBe(0);
  }, 60_000);
});

describe('F06 E 组：请求已执行但应答丢失 / 请求没有送达', () => {
  it('E3 发送的应答被吞并掐线：自动重连、核对；上行 chat.prompt 恰 1 条；乐观气泡换成真实消息；运行条在；没有错误条', async () => {
    const ctx = await setup({ S3: [{ chunks: segs(3) }] });
    const b = await renderer(ctx);
    const sid = await newSession(b);
    await b.quiet(); await ctx.proxy.upstreamIdle();
    ctx.proxy.forwardThenCut('chat.prompt');
    await b.chat.send('[[S3]] 三段');
    // 断线那一刻（重连还没开始）：记下待核对，不撤气泡、不写错误、运行标记留着。
    // 只看重连之后的终态的话，「先按失败撤掉、重连后又被快照带回来」与它分不出来
    const bubbleNow = (b.chat.messages as unknown as Msg[]).at(-1)!;
    expect([b.chat.inDoubtPrompts.length, b.chat.lastError, b.chat.running, b.chat.runningSessions]).toEqual([1, '', true, [sid]]);
    expect([bubbleNow.role, bubbleNow.id.startsWith('local-')]).toEqual(['user', true]);
    await reconnected(b, 1);
    await waitFor('核对完成、真实消息替换了乐观气泡', () => b.chat.inDoubtPrompts.length === 0 && (b.chat.messages as unknown as Msg[]).some(m => m.role === 'user' && !m.id.startsWith('local-')));
    expect(ctx.proxy.countUp('chat.prompt')).toBe(1);
    expect((b.chat.messages as unknown as Msg[]).filter(m => m.role === 'user').map(m => m.id.startsWith('local-'))).toEqual([false]);
    expect([b.chat.running, b.chat.runningSessions, b.chat.lastError, notes(b)]).toEqual([true, [sid], '', []]);
    ctx.llm.gate('S3').open();
    await waitFor('回合结束', () => !b.chat.running && texts(b.chat.messages as unknown as Msg[], 'assistant').length === 1, 20_000);
    expect(texts(b.chat.messages as unknown as Msg[], 'assistant')).toEqual([segs(3).join('')]);
    expect(texts(stored(ctx.engine.dataDir, sid), 'user')).toEqual(['[[S3]] 三段']);
    expect(ctx.llm.hitsOf('S3')).toHaveLength(1);
    expect(ctx.proxy.countUp('chat.prompt')).toBe(1);
    expect(b.unhandled()).toBe(0);
  }, 60_000);

  it('E3b 发送后切到别的会话、应答被吞并掐线，断线期间回合跑完，重连走续传：核对出「已接收且已结束」，原会话不再标着在跑；上行 chat.prompt 恰 1 条', async () => {
    const ctx = await setup({ S16: [{ chunks: segs(2) }] });
    const b = await renderer(ctx);
    const sidB = await newSession(b);
    const sidA = await newSession(b);
    await b.quiet(); await ctx.proxy.upstreamIdle();
    const resumesBefore = stats(b).resumes;

    ctx.hold();                                                            // 重连先挂着：等甲的回合在引擎里跑完再放
    ctx.proxy.forwardThenCut('chat.prompt');
    const sending = b.chat.send('[[S16]] 两段');
    const opening = b.chat.open(sidB).catch(() => undefined);              // 发完就切走（取乙的历史那一问随掐线一起丢了）
    await sending; await opening;
    await waitFor('B 进入重连', () => b.chat.connection === 'reconnecting');
    expect(b.chat.activeId).toBe(sidB);
    expect(b.chat.inDoubtPrompts.map(p => p.sessionId)).toEqual([sidA]);
    expect(b.chat.runningSessions).toEqual([sidA]);                        // 结果未知：先留着

    ctx.llm.gate('S16').open();
    await waitFor('甲的回合在引擎里结束', () => refEnded(ctx, sidA), 20_000);
    expect(runs(ctx.engine.dataDir, sidA).map(r => r.state)).toEqual(['completed']);
    ctx.release();
    await reconnected(b, 1);
    await waitFor('核对完成', () => b.chat.inDoubtPrompts.length === 0);

    expect(stats(b).resumes).toBeGreaterThan(resumesBefore);               // 走的是续传：回放里带着甲那次 run 的终止事件
    // 核对出结论与摘运行标记在同一段同步代码里：这里不用再等
    expect(b.chat.runningSessions).toEqual([]);
    expect([b.chat.activeId, b.chat.running, b.chat.undelivered, notes(b)]).toEqual([sidB, false, null, []]);
    expect(ctx.proxy.countUp('chat.prompt')).toBe(1);                      // 没有重发
    expect(ctx.llm.hitsOf('S16')).toHaveLength(1);
    await waitFor('当前会话换成乙的历史', () => ids(b.chat.messages).join() === ids(stored(ctx.engine.dataDir, sidB)).join());

    // 切回甲：不亮停止键，历史就是库里的（真实的 user 消息与回答，没有乐观气泡）
    const back = b.chat.open(sidA);
    expect([b.chat.running, b.chat.midRun]).toEqual([false, false]);
    await back;
    expect(ids(b.chat.messages)).toEqual(ids(stored(ctx.engine.dataDir, sidA)));
    expect(texts(b.chat.messages as unknown as Msg[], 'user')).toEqual(['[[S16]] 两段']);
    expect(texts(b.chat.messages as unknown as Msg[], 'assistant')).toEqual([segs(2).join('')]);
    expect(texts(stored(ctx.engine.dataDir, sidA), 'user')).toEqual(['[[S16]] 两段']);
    await b.quiet();
    expect(b.unhandled()).toBe(0);
  }, 60_000);

  for (const via of ['resume', 'snapshot'] as const) {
    it(`E4 发送没到引擎（上一次 run 是 failed；重连走${via === 'resume' ? '续传' : '快照'}）：不自动重发，事件条只有「没有送达」一条，气泡还在；点重试沿用原 promptId`, async () => {
      const ctx = await setup({ S4: [{ status: 400, body: '{"error":{"message":"坏请求"}}' }], S5: [{ text: '这次成了' }] }, via === 'snapshot' ? { eventRetention: { maxEvents: 4 } } : {});
      const b = await renderer(ctx);
      const sid = await newSession(b);
      await b.chat.send('[[S4]] 会失败的一条');
      await waitFor('上一次 run 以失败结束', () => !b.chat.running && runs(ctx.engine.dataDir, sid).some(r => r.state === 'failed'), 30_000);
      expect(b.chat.eventNotes.some(n => n.kind === 'error')).toBe(true);
      await b.quiet(); await ctx.proxy.upstreamIdle();
      const promptsBefore = ctx.proxy.countUp('chat.prompt');
      const snapshotsBefore = stats(b).snapshots; const resumesBefore = stats(b).resumes;

      if (via === 'snapshot') ctx.hold();
      ctx.proxy.cutBefore('chat.prompt');
      await b.chat.send('[[S5]] 没有送达的一条');
      if (via === 'snapshot') {
        // 断线期间产生的广播多于保留窗口：带旧游标回来只能取快照
        for (let i = 0; i < 6; i++) expect((await ctx.ref.call('chat.sessions.rename', { sessionId: sid, title: `改名 ${i}` })).error).toBeUndefined();
        ctx.release();
      }
      await reconnected(b, 1);
      await waitFor('核对完成', () => b.chat.inDoubtPrompts.length === 0 && b.chat.undelivered !== null);
      if (via === 'snapshot') expect(stats(b).snapshots).toBeGreaterThan(snapshotsBefore); else expect(stats(b).resumes).toBeGreaterThan(resumesBefore);

      expect(ctx.proxy.countUp('chat.prompt')).toBe(promptsBefore);          // 没有自动重发
      expect(notes(b)).toEqual(['连接中断时这条消息没有送达，没有自动重发。点重试重新发送。']); // 没有上一次 run 的错误条
      expect(b.chat.eventNotes[0].retryable).toBe(true);
      const last = (b.chat.messages as unknown as Msg[])[b.chat.messages.length - 1];
      expect([last.role, last.id.startsWith('local-'), texts([last], 'user')]).toEqual(['user', true, ['[[S5]] 没有送达的一条']]);
      expect([b.chat.running, b.chat.runningSessions]).toEqual([false, []]);
      expect(texts(stored(ctx.engine.dataDir, sid), 'user')).toEqual(['[[S4]] 会失败的一条']);
      const promptId = b.chat.undelivered!.promptId;

      await b.chat.retryLast();
      await waitFor('重试的回合结束', () => !b.chat.running && texts(b.chat.messages as unknown as Msg[], 'assistant').includes('这次成了'), 20_000);
      expect(ctx.proxy.countUp('chat.prompt')).toBe(promptsBefore + 1);
      expect(runs(ctx.engine.dataDir, sid).map(r => r.prompt_id).at(-1)).toBe(promptId);
      expect(texts(stored(ctx.engine.dataDir, sid), 'user')).toEqual(['[[S4]] 会失败的一条', '[[S5]] 没有送达的一条']);
      expect(ctx.llm.hitsOf('S5')).toHaveLength(1);
      expect(b.unhandled()).toBe(0);
    }, 90_000);
  }

  it('E4b 重试「没有送达」的那一条被引擎拒绝（别处刚在这个会话起了一次 run）：消息与重试入口都还在；那次 run 结束后再点重试，沿用原 promptId 送达，恰一条', async () => {
    const UNDELIVERED = '连接中断时这条消息没有送达，没有自动重发。点重试重新发送。';
    const ctx = await setup({ S17: [{ text: '这次送达了' }], S18: [{ chunks: segs(2) }] });
    const b = await renderer(ctx);
    const sid = await newSession(b);
    await b.quiet(); await ctx.proxy.upstreamIdle();
    ctx.proxy.cutBefore('chat.prompt');
    await b.chat.send('[[S17]] 没有送达的一条');
    await reconnected(b, 1);
    await waitFor('核对完成', () => b.chat.inDoubtPrompts.length === 0 && b.chat.undelivered !== null);
    const promptId = b.chat.undelivered!.promptId;
    expect(ctx.proxy.countUp('chat.prompt')).toBe(0);
    await b.quiet(); await ctx.proxy.upstreamIdle();

    // 别的窗口（直连引擎的参照客户端）在同一个会话起了一次 run，模型一个字都还没出
    expect((await ctx.ref.call('chat.prompt', { sessionId: sid, text: '[[S18]] 别处发的' })).error).toBeUndefined();

    // 点重试：这一帧到了引擎，被当场拒绝。消息不能就此没了——重试不经输入卡，没有草稿可交还
    await b.chat.retryLast();
    expect(ctx.proxy.countUp('chat.prompt')).toBe(1);
    expect(b.chat.lastError).toContain('该会话正在运行中');
    expect(b.chat.undelivered).toMatchObject({ sessionId: sid, promptId, text: '[[S17]] 没有送达的一条' });
    const last = (): Msg => (b.chat.messages as unknown as Msg[])[b.chat.messages.length - 1];
    expect([last().role, last().id.startsWith('local-'), texts([last()], 'user')]).toEqual(['user', true, ['[[S17]] 没有送达的一条']]);
    expect(b.chat.eventNotes.filter(n => n.short === UNDELIVERED).map(n => n.retryable)).toEqual([true]);
    expect(texts(stored(ctx.engine.dataDir, sid), 'user')).toEqual(['[[S18]] 别处发的']);      // 被拒的那一条没有落库
    expect(runs(ctx.engine.dataDir, sid).map(r => r.prompt_id)).toEqual([null]);

    // 别处那次 run 跑完：这个窗口照常看到它的回答；没送达的那一条仍在末尾、重试入口只有一个
    ctx.llm.gate('S18').open();
    await waitFor('别处那次 run 结束、历史换成库里的', () => refEnded(ctx, sid) && !b.chat.running
      && texts(b.chat.messages as unknown as Msg[], 'assistant').includes(segs(2).join('')) && last().id.startsWith('local-'), 20_000);
    expect(b.chat.undelivered).toMatchObject({ sessionId: sid, promptId });
    expect(texts([last()], 'user')).toEqual(['[[S17]] 没有送达的一条']);
    expect(b.chat.eventNotes.filter(n => n.short === UNDELIVERED).map(n => n.retryable)).toEqual([true]);
    await b.quiet(); await ctx.proxy.upstreamIdle();

    await b.chat.retryLast();
    await waitFor('重试的回合结束', () => !b.chat.running && texts(b.chat.messages as unknown as Msg[], 'assistant').includes('这次送达了'), 20_000);
    expect(ctx.proxy.countUp('chat.prompt')).toBe(2);
    expect(runs(ctx.engine.dataDir, sid).map(r => r.prompt_id)).toEqual([null, promptId]);
    expect(texts(stored(ctx.engine.dataDir, sid), 'user')).toEqual(['[[S18]] 别处发的', '[[S17]] 没有送达的一条']);
    expect(ctx.llm.hitsOf('S17')).toHaveLength(1);
    expect(b.chat.undelivered).toBeNull();
    await waitFor('乐观气泡换成真实消息', () => !(b.chat.messages as unknown as Msg[]).some(m => m.id.startsWith('local-')));
    expect(b.unhandled()).toBe(0);
  }, 90_000);

  it('E5 批准的应答被吞并掐线：上行 permission.respond 恰 1 条，工具执行一次，界面说「已按「允许」处理」', async () => {
    const ctx = await setup({ S6: [{ tools: [{ name: 'file_write', input: skillWriteInput('e5.txt', 'E5 的内容') }] }, { text: 'E5 完成' }] });
    const file = skillFile(ctx.engine.dataDir, 'e5.txt');
    const b = await renderer(ctx);
    const sid = await newSession(b);
    await b.chat.send('[[S6]] 写技能目录');
    await waitFor('卡片出现', () => b.chat.pendingPerms.length === 1, 20_000);
    const rid = b.chat.pendingPerms[0].requestId;
    await b.quiet(); await ctx.proxy.upstreamIdle();
    ctx.proxy.forwardThenCut('permission.respond');
    await b.chat.respondPerm(rid, 'allow-once');
    await reconnected(b, 1);
    await waitFor('核对完成', () => b.chat.inDoubtPerms.length === 0 && notes(b).length > 0);
    expect(notes(b)).toEqual(['这张权限卡已按「允许」处理。对应操作是否执行以对话里的工具结果为准']);
    expect(b.chat.pendingPerms).toEqual([]);
    await waitFor('回合结束', () => !b.chat.running && texts(stored(ctx.engine.dataDir, sid), 'assistant').includes('E5 完成'), 20_000);
    expect(ctx.proxy.countUp('permission.respond')).toBe(1);
    expect(readFileSync(file, 'utf8')).toBe('E5 的内容');
    expect(readDb(ctx.engine.dataDir, 'SELECT state, started FROM tool_executions WHERE session_id=?', sid)).toEqual([{ state: 'completed', started: 1 }]);
    expect(b.unhandled()).toBe(0);
  }, 60_000);

  it('E6 批准没到引擎：上行 permission.respond 0 条，同一张卡重新出现并说明「没有送达」；再点一次才执行，恰一次', async () => {
    const ctx = await setup({ S7: [{ tools: [{ name: 'file_write', input: skillWriteInput('e6.txt', 'E6 的内容') }] }, { text: 'E6 完成' }] });
    const file = skillFile(ctx.engine.dataDir, 'e6.txt');
    const b = await renderer(ctx);
    const sid = await newSession(b);
    await b.chat.send('[[S7]] 写技能目录');
    await waitFor('卡片出现', () => b.chat.pendingPerms.length === 1, 20_000);
    const rid = b.chat.pendingPerms[0].requestId;
    await b.quiet(); await ctx.proxy.upstreamIdle();
    ctx.proxy.cutBefore('permission.respond');
    await b.chat.respondPerm(rid, 'allow-once');
    await reconnected(b, 1);
    await waitFor('核对完成', () => b.chat.inDoubtPerms.length === 0 && notes(b).length > 0);
    expect(notes(b)).toEqual(['连接中断时你的选择没有送达，请重新选择']);
    expect(b.chat.pendingPerms.map(p => p.requestId)).toEqual([rid]);
    expect(ctx.proxy.countUp('permission.respond')).toBe(0);
    expect(existsSync(file)).toBe(false);
    expect(readDb(ctx.engine.dataDir, 'SELECT state FROM tool_executions WHERE session_id=?', sid)).toEqual([{ state: 'awaiting-approval' }]);
    expect([b.chat.running, b.chat.runningSessions]).toEqual([true, [sid]]);

    await b.chat.respondPerm(rid, 'allow-once');
    await waitFor('回合结束', () => !b.chat.running && texts(b.chat.messages as unknown as Msg[], 'assistant').includes('E6 完成'), 20_000);
    expect(ctx.proxy.countUp('permission.respond')).toBe(1);
    expect(readFileSync(file, 'utf8')).toBe('E6 的内容');
    expect(readDb(ctx.engine.dataDir, 'SELECT state, started FROM tool_executions WHERE session_id=?', sid)).toEqual([{ state: 'completed', started: 1 }]);
    expect(b.unhandled()).toBe(0);
  }, 60_000);
});

describe('F06 E 组：双客户端', () => {
  it('E7 两个窗口看同一个 run 与权限卡；其中一个掐断重连后两边一致；它批准之后另一个的卡消失；结束后两边历史相同', async () => {
    const ctx = await setup({ S8: [{ chunks: ['先说一句'], tools: [{ name: 'file_write', input: skillWriteInput('e7.txt', 'E7 的内容') }] }, { text: 'E7 完成' }] });
    const file = skillFile(ctx.engine.dataDir, 'e7.txt');
    const a = await renderer(ctx);
    const b = await renderer(ctx);
    const connB = Math.max(...ctx.proxy.connNos());
    const sid = await newSession(a);
    await b.chat.refreshSessions();
    await b.chat.open(sid);
    await a.chat.send('[[S8]] 写技能目录');
    ctx.llm.gate('S8').open();
    await waitFor('两边都看到卡', () => a.chat.pendingPerms.length === 1 && b.chat.pendingPerms.length === 1, 20_000);
    const rid = a.chat.pendingPerms[0].requestId;
    expect(b.chat.pendingPerms[0].requestId).toBe(rid);
    await waitFor('B 也认出它在跑', () => b.chat.running);
    expect([a.chat.runningSessions, b.chat.runningSessions]).toEqual([[sid], [sid]]);

    await b.quiet(); await ctx.proxy.upstreamIdle();
    ctx.proxy.cutConn(connB);
    await reconnected(b, 1);
    await waitFor('B 重取完当前会话', () => ids(b.chat.messages).join() === ids(stored(ctx.engine.dataDir, sid)).join());
    expect(a.chat.linkGeneration).toBe(0);                                 // A 没有断
    expect([b.chat.runningSessions, b.chat.running]).toEqual([[sid], true]);
    expect(b.chat.pendingPerms.map(p => p.requestId)).toEqual([rid]);
    expect(a.chat.pendingPerms.map(p => p.requestId)).toEqual([rid]);
    // B 的历史里有已落库的那一句（带工具调用的 assistant 消息），实时区没有重复它
    expect(occurrences(flow(b), '先说一句')).toBe(1);

    await b.chat.respondPerm(rid, 'allow-once');                           // 重连后的新连接可以答复这张旧卡
    await waitFor('A 的卡消失', () => a.chat.pendingPerms.length === 0);
    await waitFor('两边回合结束', () => !a.chat.running && !b.chat.running
      && ids(a.chat.messages).join() === ids(stored(ctx.engine.dataDir, sid)).join()
      && ids(b.chat.messages).join() === ids(stored(ctx.engine.dataDir, sid)).join(), 20_000);
    expect(ids(a.chat.messages)).toEqual(ids(b.chat.messages));
    expect([a.chat.runningSessions, b.chat.runningSessions]).toEqual([[], []]);
    expect(readFileSync(file, 'utf8')).toBe('E7 的内容');
    expect(readDb(ctx.engine.dataDir, 'SELECT state, started FROM tool_executions WHERE session_id=?', sid)).toEqual([{ state: 'completed', started: 1 }]);
    expect(ctx.proxy.countUp('permission.respond')).toBe(1);
    expect(ctx.proxy.countUp('chat.prompt')).toBe(1);
    expect(a.unhandled()).toBe(0);
  }, 60_000);
});

describe('F06 E 组：断线期间状态变了', () => {
  const TWO_ROUNDS: GatedStep[] = [
    { chunks: ['第一轮甲', '第一轮乙'], tools: [{ name: 'file_write', input: { path: 'e8.txt', content: 'E8 的内容', tool_title: '写 e8' } }] },
    { chunks: segs(3) },
  ];

  it('E8 断线期间回合结束，重连走续传：历史与库一致（最后一条回复与工具结果都在）、不在跑、缓冲为空；列表也是新的；再发一条，上一条回复仍在', async () => {
    const ctx = await setup({ S9: TWO_ROUNDS, S10: [{ text: '第二次的回答' }] });
    const b = await renderer(ctx);
    const sid = await newSession(b);
    await b.chat.send('[[S9]] 先写文件再回答');
    const gate = ctx.llm.gate('S9');
    gate.release(3);
    await waitFor('流到第二轮的第一段', () => b.chat.streamingText.endsWith(seg(0)), 20_000);
    await b.quiet(); await ctx.proxy.upstreamIdle();
    const resumesBefore = stats(b).resumes;
    const upBefore = ctx.proxy.upstreamCalls.length;

    ctx.hold();
    ctx.proxy.cut();
    await waitFor('B 进入重连', () => b.chat.connection === 'reconnecting');
    expect([b.chat.running, b.chat.runningSessions]).toEqual([true, [sid]]);   // 引擎里的任务还在跑，不显示成已结束
    gate.open();
    await waitFor('回合在引擎里结束', () => refEnded(ctx, sid), 20_000);
    // 断线期间别处改了会话标题、建了一个助手
    expect((await ctx.ref.call('chat.sessions.rename', { sessionId: sid, title: '断线期间改的标题' })).error).toBeUndefined();
    const made = await ctx.ref.call('assistants.create', { name: '断线期间建的助手' });
    expect(made.error).toBeUndefined();
    ctx.release();
    await reconnected(b, 1);
    const db = (): Msg[] => stored(ctx.engine.dataDir, sid);
    await waitFor('历史收敛到库', () => !b.chat.running && ids(b.chat.messages).join() === ids(db()).join() && b.chat.assistants.some(x => x.name === '断线期间建的助手'), 15_000);

    expect(stats(b).resumes).toBeGreaterThan(resumesBefore);                   // 走的是续传
    expect(db().map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(texts(b.chat.messages as unknown as Msg[], 'assistant').join('')).toBe('第一轮甲第一轮乙' + segs(3).join(''));
    expect([b.chat.running, b.chat.runningSessions, b.chat.streamingText, b.chat.toolCards]).toEqual([false, [], '', []]);
    expect(b.chat.sessions.find(s => s.id === sid)?.title).toBe('断线期间改的标题');
    // 重连后确实重取了当前会话（取历史的调用，或带会话的 attach），而且没有任何写调用
    const after = ctx.proxy.upstreamCalls.slice(upBefore).map(c => c.method);
    expect(after[0]).toBe('state.attach');
    expect(after.filter(m => m === 'chat.messages.list' || m === 'state.attach').length).toBeGreaterThanOrEqual(2);
    expect(after.filter(m => m === 'chat.prompt' || m === 'permission.respond' || m === 'chat.cancel')).toEqual([]);
    expect(b.unhandled()).toBe(0);

    const lastReply = (b.chat.messages as unknown as Msg[]).at(-1)!.id;
    await b.chat.send('[[S10]] 再问一句');
    expect(ids(b.chat.messages)).toContain(lastReply);                         // 上一条回复没有因为清缓冲而消失
    await waitFor('第二个回合结束', () => !b.chat.running && texts(b.chat.messages as unknown as Msg[], 'assistant').includes('第二次的回答'), 20_000);
    expect(ctx.llm.hitsOf('S9')).toHaveLength(2);
    expect(b.unhandled()).toBe(0);
  }, 90_000);

  it('E9 尾巴模式下（重载后接上的回合）断线期间回合结束：历史与库一致；正文在「历史 + 缓冲」里任何采样时刻只出现一次', async () => {
    const ctx = await setup({ S11: TWO_ROUNDS });
    const storage = new Map<string, string>();
    const a = await renderer(ctx, { storage });
    const sid = await newSession(a);
    await a.chat.send('[[S11]] 先写文件再回答');
    const gate = ctx.llm.gate('S11');
    gate.release(1);
    await waitFor('重载前流出第一段', () => a.chat.streamingText === '第一轮甲');
    await a.close();
    const b = await renderer(ctx, { storage });
    expect([b.chat.activeId, b.chat.joinedTail, b.chat.streamingText]).toEqual([sid, true, '第一轮甲']);

    const pieces = ['第一轮甲', '第一轮乙', seg(0), seg(1), seg(2)];
    const samples: string[] = [];
    const sample = (): void => { samples.push(flow(b)); };
    sample();
    await b.quiet(); await ctx.proxy.upstreamIdle();
    ctx.hold();
    ctx.proxy.cut();
    await waitFor('B 进入重连', () => b.chat.connection === 'reconnecting');
    gate.open();
    await waitFor('回合在引擎里结束', () => refEnded(ctx, sid), 20_000);
    ctx.release();
    const db = (): Msg[] => stored(ctx.engine.dataDir, sid);
    await waitFor('历史收敛到库', () => { sample(); return b.chat.connection === 'ok' && !b.chat.running && ids(b.chat.messages).join() === ids(db()).join(); }, 15_000);
    sample();
    expect(db().map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect([b.chat.running, b.chat.runningSessions, b.chat.streamingText, b.chat.toolCards, b.chat.joinedTail]).toEqual([false, [], '', [], false]);
    expect(flow(b)).toBe('第一轮甲第一轮乙' + segs(3).join(''));
    for (const s of samples) for (const p of pieces) expect(occurrences(s, p), `「${p}」在某一刻出现了不止一次：${s}`).toBeLessThanOrEqual(1);
    expect(ctx.llm.hitsOf('S11')).toHaveLength(2);
    expect(b.unhandled()).toBe(0);
  }, 90_000);

  it('E11 换会话的 open() 在途时断线：重连后是新会话的历史，旧会话的半截缓冲与步骤卡都不在', async () => {
    const ctx = await setup({ S12: [{ text: '乙会话的回答' }], S13: [{ chunks: segs(4) }] });
    const b = await renderer(ctx);
    const sidB = await newSession(b);
    await b.chat.send('[[S12]] 乙会话的问题');
    await waitFor('乙会话的回合结束', () => !b.chat.running && texts(b.chat.messages as unknown as Msg[], 'assistant').includes('乙会话的回答'), 20_000);
    // 回合结束后引擎会自动命名并广播 chat.sessions.changed（渲染端随即重拉列表）：等它过去，别让它正好落在后面掐线的那一刻
    await waitFor('乙会话自动命名的广播到了', () => {
      const i = ctx.ref.notifications.findIndex(n => n.method === 'chat.event' && n.params?.sessionId === sidB && n.params.event?.kind === 'turnEnd');
      return i >= 0 && ctx.ref.notifications.slice(i + 1).some(n => n.method === 'chat.sessions.changed');
    }, 20_000);
    const sidA = await newSession(b);
    await b.chat.send('[[S13]] 甲会话的问题');
    ctx.llm.gate('S13').release(2);
    await waitFor('甲会话流出半截', () => b.chat.streamingText === seg(0) + seg(1));
    await b.quiet(); await ctx.proxy.upstreamIdle();

    ctx.proxy.cutBefore('chat.messages.list');
    await b.chat.open(sidB).catch(() => undefined);
    expect(b.chat.activeId).toBe(sidB);                                        // 标题已经换了，对话流还是甲的
    await reconnected(b, 1);
    await waitFor('当前会话换成乙的历史', () => ids(b.chat.messages).join() === ids(stored(ctx.engine.dataDir, sidB)).join());
    expect([b.chat.activeId, b.chat.streamingText, b.chat.toolCards, b.chat.running]).toEqual([sidB, '', [], false]);
    expect(texts(b.chat.messages as unknown as Msg[], 'assistant')).toEqual(['乙会话的回答']);
    expect(b.chat.runningSessions).toEqual([sidA]);                            // 甲还在跑，运行条在侧栏上
    ctx.llm.gate('S13').open();
    await waitFor('甲会话的回合结束', () => b.chat.runningSessions.length === 0, 20_000);
    expect(b.unhandled()).toBe(0);
  }, 90_000);

  for (const via of ['resume', 'snapshot'] as const) {
    it(`E12 断线期间当前会话被本机别的连接删掉、另有一个会话；重连走${via === 'resume' ? '续传：回放里有生命周期广播，落到另一个会话' : '快照：广播已不在保留窗口里，落到欢迎页'}；都不留指向它的东西、没有写调用`, async () => {
      const ctx = await setup({}, via === 'snapshot' ? { eventRetention: { maxEvents: 4 } } : {});
      const b = await renderer(ctx);
      const other = await newSession(b);
      const sid = await newSession(b);
      expect([b.chat.activeId, b.storage.get('deskminis.activeSession')]).toEqual([sid, sid]);
      await b.quiet(); await ctx.proxy.upstreamIdle();
      const before = { ...stats(b) };
      const upBefore = ctx.proxy.upstreamCalls.length;

      ctx.hold();
      ctx.proxy.cut();
      await waitFor('B 进入重连', () => b.chat.connection === 'reconnecting');
      expect((await ctx.ref.call('chat.sessions.delete', { sessionId: sid, confirm: true })).error).toBeUndefined();
      if (via === 'snapshot') {
        // 断线期间产生的广播多于保留窗口：带旧游标回来只能取快照
        for (let i = 0; i < 6; i++) expect((await ctx.ref.call('chat.sessions.rename', { sessionId: other, title: `改名 ${i}` })).error).toBeUndefined();
      }
      ctx.release();
      await reconnected(b, 1);
      await waitFor('离开已删的会话', () => b.chat.activeId !== sid, 15_000);
      await b.quiet();

      if (via === 'resume') {
        expect(stats(b).resumes).toBeGreaterThan(before.resumes);
        // 本机删的：切到另一个会话，不说「另一台设备」
        expect([b.chat.activeId, notes(b), b.storage.get('deskminis.activeSession')]).toEqual([other, [], other]);
      } else {
        expect(stats(b).snapshots).toBeGreaterThan(before.snapshots);
        expect([b.chat.activeId, b.chat.messages, notes(b), b.storage.has('deskminis.activeSession')]).toEqual(['', [], [], false]);
      }
      expect(b.chat.sessions.map(s => s.id)).toEqual([other]);
      expect([b.chat.goneSessions.includes(sid), b.chat.running, b.chat.runningSessions, b.chat.pendingPerms, b.chat.undelivered, b.chat.lastError, b.chat.connection])
        .toEqual([true, false, [], [], null, '', 'ok']);
      const after = ctx.proxy.upstreamCalls.slice(upBefore).map(c => c.method);
      expect(after[0]).toBe('state.attach');
      expect(after.filter(m => m === 'chat.prompt' || m === 'permission.respond' || m === 'chat.cancel' || m === 'chat.sessions.delete')).toEqual([]);
      expect(b.unhandled()).toBe(0);
    }, 60_000);
  }
});

describe('F06 E 组：起跑期间重载', () => {
  async function startingRun(tag: string) {
    const mcp = await hangingMcp(60);
    cleanups.push(() => mcp.close());
    const ctx = await setup({ [tag]: [{ chunks: segs(2) }] }, { seed: mcp.seed });
    const storage = new Map<string, string>();
    const a = await renderer(ctx, { storage });
    const sid = await newSession(a);
    await a.quiet(); await ctx.proxy.upstreamIdle();
    // chat.prompt 卡在连 MCP 那一步：run 停在 starting，还没落 user 消息
    const sending = a.chat.send(`[[${tag}]] 起跑中重载`);
    await waitFor('run 停在 starting', () => runs(ctx.engine.dataDir, sid).some(r => r.state === 'starting'), 20_000);
    await a.close({ abrupt: true }); // 重载时 chat.prompt 还挂在连 MCP 上：不等它
    await sending;
    const b = await renderer(ctx, { storage, policy: { probeIdleMs: 1000, startPollMs: 50 } });
    return { ctx, mcp, sid, b };
  }

  it('E10 重载时 run 还在连 MCP：不点亮、记进 pendingStarts；它起跑之后（模型一个字都没出）一次探测之内点亮，历史里有那条 user 消息', async () => {
    const { ctx, mcp, sid, b } = await startingRun('S14');
    expect(b.chat.activeId).toBe(sid);
    expect([b.chat.running, b.chat.runningSessions, Object.keys(b.chat.pendingStarts)]).toEqual([false, [], [sid]]);
    expect(texts(b.chat.messages as unknown as Msg[], 'user')).toEqual([]);
    mcp.release();
    await waitFor('探测到它起跑', () => b.chat.running && b.chat.runningSessions.includes(sid) && texts(b.chat.messages as unknown as Msg[], 'user').length === 1, 15_000);
    expect(ctx.llm.gate('S14').sent()).toBe(0);                                // 模型的首个增量还没出
    expect(b.chat.pendingStarts).toEqual({});
    expect(b.chat.streamingText).toBe('');
    ctx.llm.gate('S14').open();
    await waitFor('回合结束', () => !b.chat.running && texts(b.chat.messages as unknown as Msg[], 'assistant').length === 1, 20_000);
    expect(texts(b.chat.messages as unknown as Msg[], 'assistant')).toEqual([segs(2).join('')]);
    expect(ctx.llm.hitsOf('S14')).toHaveLength(1);
    expect(b.unhandled()).toBe(0);
  }, 90_000);

  it('E10b 起跑失败（连 MCP 期间被取消）：pendingStarts 清空，会话始终没有被点亮', async () => {
    const { ctx, mcp, sid, b } = await startingRun('S15');
    expect(Object.keys(b.chat.pendingStarts)).toEqual([sid]);
    let everLit = false;
    expect((await ctx.ref.call('chat.cancel', { sessionId: sid })).error).toBeUndefined();
    mcp.release();
    await waitFor('pendingStarts 清空', () => { everLit = everLit || b.chat.running || b.chat.runningSessions.includes(sid); return Object.keys(b.chat.pendingStarts).length === 0; }, 15_000);
    expect(everLit).toBe(false);
    expect([b.chat.running, b.chat.runningSessions]).toEqual([false, []]);
    expect(notes(b)).toEqual([]);                                              // 起跑失败不由这个窗口交代
    expect(texts(stored(ctx.engine.dataDir, sid), 'user')).toEqual([]);
    expect(ctx.llm.hitsOf('S15')).toHaveLength(0);
    expect(b.unhandled()).toBe(0);
  }, 90_000);
});
