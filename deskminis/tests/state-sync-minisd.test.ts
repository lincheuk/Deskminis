/**
 * F06：真实引擎上的快照、续传与晚到事件（任务卡验收 1、2、4；阻断项「只有重连，没有原子快照 / 增量边界与 gap 检测」）。
 *
 * 进程内起真实引擎（index.ts 的装配）、真实 WebSocket、测试进程里的带闸模型端点。
 * 断言落在状态与副作用上：端点被请求了几次、库里几条消息、文件写了几次、客户端应用的序号是否逐一递增。
 *
 *  A 组：流式中途 / 审批中途换一条连接（重载、重连）——快照带尾巴与历史，待批卡是同一个 requestId 且新连接答得了；
 *  B 组：漏事件、重复、乱序、窗口过期、代次更换、快照与事件并发——经故障代理的客户端 P 与直连的参照客户端 Q 收敛到同一状态；
 *  F 组：取消、删除之后引擎不再发那个 run 的事件，之后的快照里也没有它。
 * 写调用的结果查询与双客户端、认证、取消配对在 state-sync-outcomes.test.ts。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readDb } from './run-ledger-fixture';
import { readAudit } from './permission-fixture';
import {
  bootEngine, faultProxy, gatedLlm, publishedText, runEventsOf, seg, segs, skillFile, skillWriteInput, streamClient, waitFor, wireClient,
  type BootOpts, type BootedEngine, type GatedLlm, type GatedStep, type StreamClient, type WireClient, type WireFrame,
} from './state-sync-fixture';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) { try { await f(); } catch { /* 收尾尽力 */ } }
});

async function boot(scripts: Record<string, GatedStep[]> = {}, opts: BootOpts = {}): Promise<{ engine: BootedEngine; llm: GatedLlm }> {
  const llm = await gatedLlm(scripts);
  cleanups.push(() => llm.close());
  const engine = await bootEngine({ llm, ...opts });
  cleanups.push(() => engine.close());
  return { engine, llm };
}
async function wire(port: number, token: string): Promise<WireClient> {
  const c = wireClient(port, token);
  await c.ready;
  cleanups.push(() => c.terminate());
  return c;
}
/** 带游标的客户端，已做过首次同步（快照）。 */
async function stream(port: number, token: string): Promise<StreamClient> {
  const c = streamClient(port, token);
  await c.ready;
  cleanups.push(() => c.sock.terminate());
  await c.attach();
  return c;
}
type Caller = { call(method: string, params?: unknown): Promise<WireFrame> };
const mkSession = async (c: Caller): Promise<string> => (await c.call('chat.sessions.create', {})).result.id as string;
async function send(c: Caller, sessionId: string, text: string, promptId: string): Promise<any> {
  const r = await c.call('chat.prompt', { sessionId, text, promptId });
  expect(r.error).toBeUndefined();
  return r.result;
}
const isDelta = (text?: string) => (f: WireFrame): boolean =>
  f.method === 'chat.event' && f.params?.event?.kind === 'textDelta' && (text === undefined || f.params.event.text === text);
const textOf = (events: any[]): string => events.filter(e => e.kind === 'textDelta').map(e => e.text).join('');
const ended = (events: any[]): boolean => events.some(e => e.kind === 'turnEnd' || e.kind === 'error');
type Msg = { id: string; role: string; parts: { type: string; value: any }[] };
const userTexts = (msgs: Msg[]): string[] => msgs.filter(m => m.role === 'user').flatMap(m => m.parts).filter(p => p.type === 'text').map(p => p.value as string);
const assistantText = (msgs: Msg[]): string => msgs.filter(m => m.role === 'assistant').flatMap(m => m.parts).filter(p => p.type === 'text').map(p => p.value as string).join('');
const storedMessages = (dataDir: string, sessionId: string): Msg[] =>
  readDb<{ id: string; role: string; parts_json: string }>(dataDir, 'SELECT id, role, parts_json FROM messages WHERE session_id=? ORDER BY created_at ASC, id ASC', sessionId)
    .map(r => ({ id: r.id, role: r.role, parts: JSON.parse(r.parts_json) as Msg['parts'] }));
const runRows = (dataDir: string, sessionId: string): any[] => readDb(dataDir, 'SELECT * FROM agent_runs WHERE session_id=? ORDER BY generation', sessionId);
const execRows = (dataDir: string, sessionId: string): any[] => readDb(dataDir, 'SELECT * FROM tool_executions WHERE session_id=? ORDER BY batch, call_index', sessionId);
const cardOf = (c: Pick<WireClient, 'notifications'>, sessionId: string): WireFrame | undefined =>
  c.notifications.find(n => n.method === 'permission.request' && n.params.req.sessionId === sessionId);

describe('F06 A 组：流式中途 / 审批中途换一条连接', () => {
  it('A1 流到第一段时旧连接关掉，新连接不带游标 attach：快照带尾巴与历史；之后逐段接着长；模型只被请求一次，库里一条 user、一条完整的 assistant', async () => {
    const { engine, llm } = await boot({ S1: [{ chunks: segs(4) }] });
    const a = await wire(engine.port, engine.token);
    const sid = await mkSession(a);
    await send(a, sid, '[[S1]] 分四段', 'f06-a1-0001');
    const gate = llm.gate('S1');
    gate.release(1);
    await waitFor('A 收到第一段', () => publishedText(a, sid) === seg(0));
    a.terminate();

    const b = streamClient(engine.port, engine.token);
    await b.ready;
    cleanups.push(() => b.sock.terminate());
    const r = await b.attach({ sessionId: sid });
    expect(r.mode).toBe('snapshot');
    if (r.mode !== 'snapshot') throw new Error('应当是快照');
    expect(r.reason).toBe('no-cursor');
    // 已发布、还没落库的那一段在尾巴里；历史里只有那条 user 消息
    expect(b.tailOf(sid)?.text).toBe(seg(0));
    expect(r.snapshot.runs.filter(x => x.sessionId === sid).map(x => [x.state, x.generation])).toEqual([['running', 1]]);
    const msgs = r.snapshot.session!.messages as unknown as Msg[];
    expect(r.snapshot.session!.exists).toBe(true);
    expect(userTexts(msgs)).toEqual(['[[S1]] 分四段']);
    expect(msgs.filter(m => m.role === 'assistant')).toEqual([]);
    expect(r.snapshot.sessions.map(s => s.id)).toEqual([sid]);

    for (let i = 1; i <= 2; i++) {
      gate.release(1);
      await waitFor(`B 的尾巴长到第 ${i} 段`, () => b.tailOf(sid)?.text === segs(i + 1).join(''));
    }
    gate.open();
    await waitFor('回合结束', () => ended(b.eventsOf(sid)), 20_000);
    // 快照里的尾巴 + 之后应用的增量 = 全文，一段不多、一段不少
    expect(seg(0) + textOf(b.eventsOf(sid))).toBe(segs(4).join(''));
    expect(b.tailOf(sid)).toBeUndefined();
    expect(b.continuity()).toBeUndefined();

    expect(llm.hitsOf('S1')).toHaveLength(1);
    const stored = storedMessages(engine.dataDir, sid);
    expect(stored.map(m => m.role)).toEqual(['user', 'assistant']);
    expect(assistantText(stored)).toBe(segs(4).join(''));
    expect(runRows(engine.dataDir, sid).map(x => [x.state, x.generation])).toEqual([['completed', 1]]);
  }, 40_000);

  it('A2 带工具的回合在第二轮流式中途换连接：历史里有第一轮的 assistant 与结果消息，尾巴只有第二轮已发布的部分；改动清单有那次写入；文件只写一次', async () => {
    const { engine, llm } = await boot({
      S2: [
        { chunks: ['第一轮甲', '第一轮乙'], tools: [{ name: 'file_write', input: { path: 'a2.txt', content: 'A2 的内容', tool_title: '写 a2' } }] },
        { chunks: segs(3) },
      ],
    });
    const a = await wire(engine.port, engine.token);
    const sid = await mkSession(a);
    const wsRoot = (await a.call('workspace.get', { sessionId: sid })).result.root as string;
    await send(a, sid, '[[S2]] 先写文件再回答', 'f06-a2-0001');
    const gate = llm.gate('S2');
    gate.release(2);
    await waitFor('第二轮请求到达端点', () => llm.hitsOf('S2').length === 2, 20_000);
    // 没弹卡（工作区里的写入免审）
    expect(cardOf(a, sid)).toBeUndefined();
    gate.release(1);
    await waitFor('A 收到第二轮第一段', () => publishedText(a, sid) === '第一轮甲第一轮乙' + seg(0));
    a.terminate();

    const b = streamClient(engine.port, engine.token);
    await b.ready;
    cleanups.push(() => b.sock.terminate());
    const r = await b.attach({ sessionId: sid });
    if (r.mode !== 'snapshot') throw new Error('应当是快照');
    const msgs = r.snapshot.session!.messages as unknown as Msg[];
    expect(msgs.map(m => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(assistantText(msgs)).toBe('第一轮甲第一轮乙');
    expect(msgs[1].parts.filter(p => p.type === 'toolUse').map(p => p.value.name)).toEqual(['file_write']);
    expect(msgs[2].parts.filter(p => p.type === 'toolResult').map(p => p.value.status)).toEqual(['success']);
    // 第一轮正文已随消息落库：尾巴在 messagePersisted 时清过，只剩第二轮已发布的那一段
    expect(b.tailOf(sid)?.text).toBe(seg(0));
    expect(r.snapshot.artifacts.filter(x => x.sessionId === sid)).toMatchObject([{ tool: 'file_write', state: 'completed', toolUseId: 'call_S2_0_0' }]);
    expect(r.snapshot.artifacts[0].writePaths.map(p => p.replace(/\\/g, '/').split('/').pop())).toEqual(['a2.txt']);
    expect(readFileSync(join(wsRoot, 'a2.txt'), 'utf8')).toBe('A2 的内容');

    gate.open();
    await waitFor('回合结束', () => ended(b.eventsOf(sid)), 20_000);
    expect(seg(0) + textOf(b.eventsOf(sid))).toBe(segs(3).join(''));
    expect(b.continuity()).toBeUndefined();
    expect(llm.hitsOf('S2')).toHaveLength(2);
    expect(execRows(engine.dataDir, sid).map(x => [x.state, x.started])).toEqual([['completed', 1]]);
    const stored = storedMessages(engine.dataDir, sid);
    expect(stored.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(assistantText(stored)).toBe('第一轮甲第一轮乙' + segs(3).join(''));
  }, 40_000);

  it('A3 回合停在权限卡上，换一条新连接：没 attach 就答 → undelivered；attach 得到同一张卡（req / meta 与广播深相等）→ 再答生效；工具执行一次；审计有一条补发记录', async () => {
    const { engine, llm } = await boot({ S3: [{ tools: [{ name: 'file_write', input: skillWriteInput('a3.txt', 'A3 的内容') }] }, { text: 'A3 完成' }] }, { permTimeoutMs: 60_000 });
    const file = skillFile(engine.dataDir, 'a3.txt');
    const a = await wire(engine.port, engine.token);
    const sid = await mkSession(a);
    await send(a, sid, '[[S3]] 写技能目录', 'f06-a3-0001');
    await waitFor('A 收到权限卡', () => cardOf(a, sid) !== undefined);
    const card = cardOf(a, sid)!;
    const R = card.params.requestId as string;
    a.terminate();

    const b = await wire(engine.port, engine.token);
    expect((await b.call('permission.respond', { requestId: R, decision: 'allow-once' })).result).toEqual({ ok: true, applied: false, undelivered: true });
    expect(existsSync(file)).toBe(false);

    const at = (await b.call('state.attach', { sessionId: sid })).result;
    expect(at.mode).toBe('snapshot');
    const cards = at.snapshot.pendingPermissions as any[];
    expect(cards).toHaveLength(1);
    expect(cards[0].requestId).toBe(R);
    expect(cards[0].req).toEqual(card.params.req);
    expect(cards[0].meta).toEqual(card.params.meta);
    expect(cards[0].origin).toBe('tool');
    expect(cards[0].remainingMs).toBeGreaterThan(0);
    expect(cards[0].remainingMs).toBeLessThanOrEqual(60_000);
    // 快照里的账本与卡是同一时刻的：那次调用在审批中，记着同一个 requestId
    expect((at.snapshot.executions as any[]).filter(x => x.sessionId === sid).map(x => [x.state, x.approval?.requestId])).toEqual([['awaiting-approval', R]]);

    expect((await b.call('permission.respond', { requestId: R, decision: 'allow-once' })).result).toEqual({ ok: true, applied: true });
    await waitFor('回合结束', () => ended(runEventsOf(b, sid)), 20_000);
    expect(readFileSync(file, 'utf8')).toBe('A3 的内容');
    expect(execRows(engine.dataDir, sid).map(x => [x.state, x.started])).toEqual([['completed', 1]]);
    expect(llm.hitsOf('S3')).toHaveLength(2);
    expect(userTexts(storedMessages(engine.dataDir, sid))).toEqual(['[[S3]] 写技能目录']);
    const redelivered = readAudit(engine.dataDir).filter(x => x.eventType === 'permission.redelivered');
    expect(redelivered).toHaveLength(1);
    expect(redelivered[0]).toMatchObject({ sessionId: sid, payload: { requestId: R, by: 'local' } });
  }, 40_000);

  it('A4 断线重连走续传：连着时收到卡，掐断后新套接字带游标 attach → resume，应答里仍带这张卡，新连接答复生效', async () => {
    const { engine } = await boot({ S4: [{ tools: [{ name: 'file_write', input: skillWriteInput('a4.txt', 'A4 的内容') }] }, { text: 'A4 完成' }] });
    const file = skillFile(engine.dataDir, 'a4.txt');
    const b = await stream(engine.port, engine.token);
    const sid = await mkSession(b);
    await send(b, sid, '[[S4]] 写技能目录', 'f06-a4-0001');
    await waitFor('B 收到权限卡', () => b.cardIds().length === 1);
    const R = b.cardIds()[0];

    const r = await b.reconnect(engine.port, engine.token);
    // 卡是断线前发的，不在回放里；续传的应答照样带着它，并把新连接登记为可答复
    expect(r.mode).toBe('resume');
    if (r.mode !== 'resume') throw new Error('应当是续传');
    // 回放里没有这张卡（别的广播——落库后的 sync.dirty 之类——可能正好落在断线那一小段里，不拿「回放为空」来比）
    expect(r.events.filter(f => f.method === 'permission.request' || f.method === 'permission.resolved')).toEqual([]);
    expect(r.pendingPermissions.map(x => x.requestId)).toEqual([R]);
    expect(b.cardIds()).toEqual([R]);
    expect((await b.call('permission.respond', { requestId: R, decision: 'allow-once' })).result).toEqual({ ok: true, applied: true });
    await waitFor('回合结束', () => ended(b.eventsOf(sid)), 20_000);
    expect(readFileSync(file, 'utf8')).toBe('A4 的内容');
    expect(execRows(engine.dataDir, sid).map(x => [x.state, x.started])).toEqual([['completed', 1]]);
    expect(b.cardIds()).toEqual([]);
    expect(b.continuity()).toBeUndefined();
  }, 40_000);
});

describe('F06 B 组：漏事件、重复、乱序、窗口过期、代次更换、快照与事件并发', () => {
  /** P 经故障代理，Q 直连；两边都已做过首次同步。 */
  async function pq(engine: BootedEngine) {
    const proxy = await faultProxy(engine.port);
    cleanups.push(() => proxy.close());
    const p = await stream(proxy.port, engine.token);
    const q = await stream(engine.port, engine.token);
    return { proxy, p, q };
  }
  /** P 与 Q 此刻的尾巴、待批卡集合相同，P 应用的序号没有空洞、没有重复。 */
  function expectConverged(p: StreamClient, q: StreamClient): void {
    expect(p.tails()).toEqual(q.tails());
    expect(p.cardIds()).toEqual(q.cardIds());
    expect(p.continuity()).toBeUndefined();
    expect(q.continuity()).toBeUndefined();
  }

  it('B1 漏事件：代理吞掉一条 textDelta——下一帧到达时发现空洞，续传一次补齐；文本与参照客户端相同', async () => {
    const { engine, llm } = await boot({ S1: [{ chunks: segs(6) }] });
    const { proxy, p, q } = await pq(engine);
    const sid = await mkSession(q);
    await waitFor('P 应用了建会话之前的帧', () => p.settled());
    proxy.drop(isDelta(seg(2)));
    await send(q, sid, '[[S1]] 六段', 'f06-b1-0001');
    llm.gate('S1').release(5);
    const five = segs(5).join('');
    await waitFor('Q 收到前五段', () => q.tailOf(sid)?.text === five);
    await waitFor('P 补齐前五段', () => p.settled() && p.tailOf(sid)?.text === five);
    // 注入确实发生：那一帧一次都没发给 P
    expect(proxy.downstream.filter(d => isDelta(seg(2))(d.frame)).map(d => d.delivered)).toEqual([0]);
    expect(p.tracker.stats.gaps).toBe(1);
    expect(p.attaches.filter(x => x.mode === 'resume')).toMatchObject([{ accepted: true }]);
    expect(p.attaches.filter(x => x.mode === 'snapshot')).toHaveLength(1); // 只有首次同步那一份
    expectConverged(p, q);

    llm.gate('S1').open();
    await waitFor('两边都收到回合结束', () => ended(p.eventsOf(sid)) && ended(q.eventsOf(sid)), 20_000);
    expect(textOf(p.eventsOf(sid))).toBe(segs(6).join(''));
    expect(textOf(q.eventsOf(sid))).toBe(segs(6).join(''));
    expectConverged(p, q);
  }, 40_000);

  it('B2 重复：代理把三条 textDelta 各发两次——三条重复帧被丢弃，文本不重复', async () => {
    const { engine, llm } = await boot({ S1: [{ chunks: segs(5) }] });
    const { proxy, p, q } = await pq(engine);
    const sid = await mkSession(q);
    proxy.duplicate(isDelta(), 3);
    await send(q, sid, '[[S1]] 五段', 'f06-b2-0001');
    llm.gate('S1').release(4);
    const four = segs(4).join('');
    await waitFor('两边收到前四段', () => q.tailOf(sid)?.text === four && p.tailOf(sid)?.text === four && p.settled());
    expect(proxy.downstream.filter(d => isDelta()(d.frame)).map(d => d.delivered)).toEqual([2, 2, 2, 1]);
    expect(p.tracker.stats.duplicates).toBe(3);
    expect(p.tracker.stats.gaps).toBe(0);
    expectConverged(p, q);
    llm.gate('S1').open();
    await waitFor('两边都收到回合结束', () => ended(p.eventsOf(sid)) && ended(q.eventsOf(sid)), 20_000);
    expect(textOf(p.eventsOf(sid))).toBe(segs(5).join(''));
    expectConverged(p, q);
  }, 40_000);

  it('B3 乱序：代理交换相邻两条——先到的那条触发续传，晚到的那条按重复丢弃；文本顺序不乱', async () => {
    const { engine, llm } = await boot({ S1: [{ chunks: segs(5) }] });
    const { proxy, p, q } = await pq(engine);
    const sid = await mkSession(q);
    await waitFor('P 应用了建会话之前的帧', () => p.settled());
    proxy.swapNext(isDelta(seg(1)));
    await send(q, sid, '[[S1]] 五段', 'f06-b3-0001');
    llm.gate('S1').release(4);
    const four = segs(4).join('');
    await waitFor('两边收到前四段', () => q.tailOf(sid)?.text === four && p.settled() && p.tailOf(sid)?.text === four);
    // 线上到达 P 的顺序确实是 ‹0› ‹2› ‹1› …
    const arrived = p.notifications.filter(isDelta()).map(n => n.params.event.text as string);
    expect(arrived.slice(0, 3)).toEqual([seg(0), seg(2), seg(1)]);
    expect(p.tracker.stats.gaps).toBe(1);
    expect(p.tracker.stats.duplicates).toBeGreaterThanOrEqual(1);
    expect(textOf(p.eventsOf(sid))).toBe(four);
    expectConverged(p, q);
    llm.gate('S1').open();
    await waitFor('两边都收到回合结束', () => ended(p.eventsOf(sid)) && ended(q.eventsOf(sid)), 20_000);
    expect(textOf(p.eventsOf(sid))).toBe(segs(5).join(''));
    expectConverged(p, q);
  }, 40_000);

  it('B4 窗口过期：窗口只留 8 条，断线期间发了二十多条——带旧游标重连得到快照 / window-expired；游标恰好是窗口第一条的前一条走续传，再小一走快照', async () => {
    const { engine, llm } = await boot({ S1: [{ chunks: segs(30) }] }, { eventRetention: { maxEvents: 8 } });
    const p = await stream(engine.port, engine.token);
    const q = await stream(engine.port, engine.token);
    const sid = await mkSession(q);
    await send(q, sid, '[[S1]] 三十段', 'f06-b4-0001');
    const gate = llm.gate('S1');
    gate.release(2);
    await waitFor('两边收到前两段', () => q.tailOf(sid)?.text === segs(2).join('') && p.tailOf(sid)?.text === segs(2).join(''));
    const cursorBefore = { ...p.tracker.cursor! };
    p.sock.terminate();
    gate.release(22);
    const sofar = segs(24).join('');
    await waitFor('Q 收到前二十四段', () => q.tailOf(sid)?.text === sofar);

    const r = await p.reconnect(engine.port, engine.token);
    expect(r.mode).toBe('snapshot');
    if (r.mode !== 'snapshot') throw new Error('应当是快照');
    expect(r.reason).toBe('window-expired');
    expect(r.window).toEqual({ firstSeq: r.lastSeq - 7, maxEvents: 8, maxChars: 8_000_000 });
    expect(r.lastSeq - cursorBefore.lastSeq).toBeGreaterThan(8);
    expect(p.tailOf(sid)?.text).toBe(sofar);
    expect(p.tails()).toEqual(q.tails());

    // 边界：下面这几次调用要落在同一个水位上。回合停在闸上，不再有 run 事件；但落库之后的 sync.dirty 是去抖后才广播的，
    // 机器负载高时可能正好落在两次调用之间（全量并跑时红过一次）。每个应答都带着当时的 lastSeq：水位动了就整组重取，断言不变
    const w = await wire(engine.port, engine.token);
    const at = async (resume: unknown): Promise<any> => (await w.call('state.attach', { resume })).result;
    let epoch = 0; let instanceId = ''; let lastSeq = 0; let firstSeq = 0;
    let edge: any; let over: any; let same: any;
    for (let attempt = 1; ; attempt++) {
      const head = (await w.call('state.attach', {})).result;
      ({ epoch, instanceId, lastSeq } = head as { epoch: number; instanceId: string; lastSeq: number });
      firstSeq = head.window.firstSeq as number;
      edge = await at({ epoch, instanceId, lastSeq: firstSeq - 1 });
      over = await at({ epoch, instanceId, lastSeq: firstSeq - 2 });
      same = await at({ epoch, instanceId, lastSeq });
      if ([edge, over, same].every(x => x.lastSeq === lastSeq)) break;
      expect(attempt, '水位一直在动：这一组边界断言取不到同一个水位').toBeLessThan(5);
    }
    expect(lastSeq - firstSeq + 1).toBe(8);
    expect(edge.mode).toBe('resume');
    expect((edge.events as any[]).map(e => e.ev.seq)).toEqual(Array.from({ length: 8 }, (_, i) => firstSeq + i));
    expect(edge.lastSeq).toBe(lastSeq);
    expect([over.mode, over.reason]).toEqual(['snapshot', 'window-expired']);
    expect([same.mode, same.events]).toEqual(['resume', []]);
    const ahead = await at({ epoch, instanceId, lastSeq: lastSeq + 5 });
    expect([ahead.mode, ahead.reason]).toEqual(['snapshot', 'ahead']);
    const otherInstance = await at({ epoch, instanceId: 'SOMEONE-ELSE', lastSeq });
    expect([otherInstance.mode, otherInstance.reason]).toEqual(['snapshot', 'epoch-changed']);
    const otherEpoch = await at({ epoch: epoch + 1, instanceId, lastSeq });
    expect([otherEpoch.mode, otherEpoch.reason]).toEqual(['snapshot', 'epoch-changed']);
    for (const bad of [{ epoch, instanceId, lastSeq: -1 }, { epoch, instanceId, lastSeq: 1.5 }, { epoch: String(epoch), instanceId, lastSeq }, 'cursor', null]) {
      const b = await at(bad);
      expect([b.mode, b.reason]).toEqual(['snapshot', 'no-cursor']);
    }

    gate.open();
    await waitFor('两边都收到回合结束', () => ended(p.eventsOf(sid)) && ended(q.eventsOf(sid)), 20_000);
    expect(sofar + textOf(p.eventsOf(sid).slice(p.eventsOf(sid).findIndex(e => e.kind === 'textDelta' && e.text === seg(24))))).toBe(segs(30).join(''));
    expect(p.continuity()).toBeUndefined();
    expect(p.tails()).toEqual(q.tails());
    expect(assistantText(storedMessages(engine.dataDir, sid))).toBe(segs(30).join(''));
  }, 60_000);

  it('B5 代次更换（有序重启）：带旧游标与新 token 重连 → 快照 / epoch-changed；旧卡不在、没有尾巴；那次运行是 cancelled / shutdown、工具结果是已取消、文件没写；旧代次的帧不起作用；旧 token 被拒', async () => {
    const { engine } = await boot({ S5: [{ tools: [{ name: 'file_write', input: skillWriteInput('b5.txt', '不该落盘') }] }, { text: 'B5 完成' }] });
    const file = skillFile(engine.dataDir, 'b5.txt');
    const proxy = await faultProxy(engine.port);
    cleanups.push(() => proxy.close());
    const p = await stream(proxy.port, engine.token);
    const sid = await mkSession(p);
    await send(p, sid, '[[S5]] 写技能目录', 'f06-b5-0001');
    await waitFor('P 收到权限卡', () => p.cardIds().length === 1);
    const R = p.cardIds()[0];
    const old = { cursor: { ...p.tracker.cursor! }, token: engine.token };

    await engine.restart();
    proxy.retarget(engine.port);
    expect(engine.token).not.toBe(old.token);
    const r = await p.reconnect(proxy.port, engine.token, { sessionId: sid });
    expect(r.mode).toBe('snapshot');
    if (r.mode !== 'snapshot') throw new Error('应当是快照');
    expect(r.reason).toBe('epoch-changed');
    expect(r.epoch).toBe(old.cursor.epoch + 1);
    expect(r.instanceId).not.toBe(old.cursor.instanceId);
    expect(r.snapshot.live).toEqual([]);
    expect(r.snapshot.pendingPermissions).toEqual([]);
    expect(p.cardIds()).toEqual([]);
    // 有序关停先了结卡、再停 run：不是 interrupted（那要强杀进程，见 state-sync-process）
    expect(r.snapshot.runs.filter(x => x.sessionId === sid).map(x => [x.state, x.stopReason, x.epoch])).toEqual([['cancelled', 'shutdown', old.cursor.epoch]]);
    const msgs = r.snapshot.session!.messages as unknown as Msg[];
    const results = msgs.flatMap(m => m.parts).filter(x => x.type === 'toolResult').map(x => x.value);
    expect(results.map(x => x.status)).toEqual(['cancelled']);
    expect(String(results[0].output)).toContain('已取消');
    expect(existsSync(file)).toBe(false);

    // 往 P 注入一帧旧代次的增量：判为别的代次，不交付、状态不变
    const before = { applied: p.applied.length, foreign: p.tracker.stats.foreign };
    const verdict = p.tracker.offer({
      method: 'chat.event', ev: { epoch: old.cursor.epoch, seq: old.cursor.lastSeq + 1 },
      params: { sessionId: sid, event: { kind: 'textDelta', text: '旧代次的字' }, run: { id: 'OLD', generation: 1, epoch: old.cursor.epoch } },
    });
    expect(verdict).toEqual({ deliver: [], need: 'snapshot' });
    expect(p.tracker.stats.foreign).toBe(before.foreign + 1);
    expect(p.applied.length).toBe(before.applied);
    expect(p.tails()).toEqual([]);
    await p.attach({ forceSnapshot: true });

    // 旧 token 连不上
    const stale = wireClient(engine.port, old.token);
    await expect(stale.ready).rejects.toBeDefined();

    // 凭旧代次的 requestId 答复：新引擎不认识这张卡
    expect((await p.call('permission.respond', { requestId: R, decision: 'allow-once' })).result).toEqual({ ok: true, applied: false });
    // 查询能说清它的结局：账本里那条审批记成了「随运行取消」，没有执行
    const o = (await p.call('state.outcomes', { refs: [{ kind: 'permission', requestId: R }] })).result;
    expect(o.epoch).toBe(old.cursor.epoch + 1);
    expect(o.outcomes).toHaveLength(1);
    // cause 是 'shutdown'：了结卡片那一步把原因交给了网关，网关记进账本的时刻早于 run 收尾的兜底（实测 5 / 5，见交付说明）
    expect(o.outcomes[0]).toEqual({
      kind: 'permission', requestId: R, status: 'settled', source: 'ledger', sessionId: sid, toolUseId: 'call_S5_0_0', epoch: old.cursor.epoch,
      approval: { state: 'denied', reason: 'cancelled', cause: 'shutdown' }, execution: 'cancelled',
    });
    expect(existsSync(file)).toBe(false);
  }, 60_000);

  it('B6 快照与事件并发：三百段连发期间二十多个客户端在不同时刻取快照——每一份都满足「已落库正文 + 尾巴 + 水位之后的增量 = 全文」；同一 (lastSeq, revision) 的两份快照内容相同', async () => {
    const N = 300;
    const { engine, llm } = await boot({ S6: [{ chunks: segs(N) }] });
    const full = segs(N).join('');
    const first = await wire(engine.port, engine.token);
    const sid = await mkSession(first);
    await send(first, sid, '[[S6]] 三百段', 'f06-b6-0001');
    const gate = llm.gate('S6');
    const taken: { c: WireClient; r: any }[] = [];
    let stop = false;
    // 另一个客户端不停地强制取快照；每次连发两帧（同一拍到达，中间插不进事件）
    const hammer = await wire(engine.port, engine.token);
    const pairs: [any, any][] = [];
    const hammering = (async () => {
      while (!stop || pairs.length < 20) {
        const [x, y] = await Promise.all([hammer.call('state.attach', { sessionId: sid }), hammer.call('state.attach', { sessionId: sid })]);
        expect(x.error).toBeUndefined();
        expect(y.error).toBeUndefined();
        taken.push({ c: hammer, r: x.result }, { c: hammer, r: y.result });
        pairs.push([x.result, y.result]);
      }
    })();
    for (let i = 0; i < 20; i++) {
      gate.release(15);
      const c = await wire(engine.port, engine.token);
      const r = await c.call('state.attach', { sessionId: sid });
      expect(r.error).toBeUndefined();
      taken.push({ c, r: r.result });
    }
    gate.open();
    await waitFor('回合结束', () => ended(runEventsOf(first, sid)), 30_000);
    stop = true;
    await hammering;
    // 回合结束之后再取一份：正文全在历史里，尾巴为空
    const late = await wire(engine.port, engine.token);
    taken.push({ c: late, r: (await late.call('state.attach', { sessionId: sid })).result });

    expect(assistantText(storedMessages(engine.dataDir, sid))).toBe(full);
    let mid = 0;
    for (const { c, r } of taken) {
      expect(r.mode).toBe('snapshot');
      const snap = r.snapshot;
      const persisted = assistantText(snap.session.messages as Msg[]);
      const live = ((snap.live as any[]).find(x => x.sessionId === sid)?.text ?? '') as string;
      const after = c.notifications.filter(n => n.ev !== undefined && n.ev.seq > snap.lastSeq && isDelta()(n)).map(n => n.params.event.text as string).join('');
      expect(persisted + live + after, `水位 ${snap.lastSeq as number}`).toBe(full);
      if (live.length > 0 && live.length < full.length && after.length > 0) mid += 1;
    }
    // 确实有不少快照落在流式中途（否则上面的等式只是在比两个端点）
    expect(mid).toBeGreaterThanOrEqual(10);
    expect(taken.length).toBeGreaterThanOrEqual(60);
    // 同一拍取的两份：水位与修订号相同，内容深相等（takenAt 除外）
    const strip = (r: any): unknown => ({ ...r, snapshot: { ...r.snapshot, takenAt: 0 } });
    for (const [x, y] of pairs) {
      expect([y.lastSeq, y.revision]).toEqual([x.lastSeq, x.revision]);
      expect(strip(y)).toEqual(strip(x));
    }
    // 修订号在本代次内单调不减
    const byTime = taken.filter(t => t.c === hammer).map(t => t.r.revision as number);
    for (let i = 1; i < byTime.length; i++) expect(byTime[i]).toBeGreaterThanOrEqual(byTime[i - 1]);
    expect(llm.hitsOf('S6')).toHaveLength(1);
  }, 90_000);
});

describe('F06 F 组：取消、删除之后的晚到事件', () => {
  it('F1 流式中途取消：error 之后引擎不再发这个 run 的任何事件；之后的快照里没有它的尾巴、它不在跑；重放取消前的一条增量按重复丢弃', async () => {
    const { engine, llm } = await boot({ S1: [{ chunks: segs(4) }] });
    const proxy = await faultProxy(engine.port);
    cleanups.push(() => proxy.close());
    const p = await stream(proxy.port, engine.token);
    const q = await stream(engine.port, engine.token);
    const sid = await mkSession(q);
    await send(q, sid, '[[S1]] 四段', 'f06-f1-0001');
    const gate = llm.gate('S1');
    gate.release(2);
    const two = segs(2).join('');
    await waitFor('两边收到前两段', () => q.tailOf(sid)?.text === two && p.tailOf(sid)?.text === two);

    expect((await q.call('chat.cancel', { sessionId: sid })).error).toBeUndefined();
    await waitFor('两边收到取消的终止事件', () => ended(q.eventsOf(sid)) && ended(p.eventsOf(sid)));
    gate.open();
    // 再触发一条别的广播并等它到达：取消之后若还有这个 run 的事件，一定排在它前面
    const mark = `F1 之后 ${Date.now()}`;
    expect((await q.call('chat.sessions.rename', { sessionId: sid, title: mark.slice(0, 20) })).error).toBeUndefined();
    await waitFor('两边收到改名的广播', () => [p, q].every(c => {
      const i = c.applied.map(f => f.method === 'chat.event' && (f.params as any).event?.kind === 'error').lastIndexOf(true);
      return c.applied.slice(i + 1).some(f => f.method === 'chat.sessions.changed');
    }));
    for (const c of [p, q]) {
      const ev = c.eventsOf(sid);
      expect(ev[ev.length - 1]).toMatchObject({ kind: 'error', message: '已取消' });
      expect(textOf(ev)).toBe(two);
      expect(c.tailOf(sid)).toBeUndefined();
    }
    // 取消时已流出的半截落了库（F05 之前就有的行为），run 记 cancelled
    expect(runRows(engine.dataDir, sid).map(x => [x.state, x.stop_reason])).toEqual([['cancelled', 'user-stop']]);
    const r = await q.attach({ sessionId: sid, forceSnapshot: true });
    if (r.mode !== 'snapshot') throw new Error('应当是快照');
    expect(r.snapshot.live).toEqual([]);
    expect(r.snapshot.runs.filter(x => x.sessionId === sid).map(x => x.state)).toEqual(['cancelled']);

    // 晚到的重复帧：把取消前的一条增量再发一遍
    const dup = p.tracker.stats.duplicates;
    // 只数这一帧被应用了几次：这段时间里别的广播（改名、自动命名）照常到达，不能拿应用总数来比
    const appliedOf = (): number => p.applied.filter(f => isDelta(seg(1))(f as WireFrame)).length;
    expect(appliedOf()).toBe(1);
    expect(proxy.replay(isDelta(seg(1)))).toBe(true);
    await waitFor('P 收到重放的那一帧', () => p.notifications.filter(isDelta(seg(1))).length === 2);
    expect(p.tracker.stats.duplicates).toBe(dup + 1);
    expect(appliedOf()).toBe(1);
    expect(textOf(p.eventsOf(sid))).toBe(two);
    expect(p.continuity()).toBeUndefined();
    expect(llm.hitsOf('S1')).toHaveLength(1);
  }, 40_000);

  it('F2 回合挂在权限卡上时另一条连接删除会话：卡的了结、run 的终止事件、会话列表变更按这个顺序发出；之后的快照里没有这个会话', async () => {
    const { engine } = await boot({ S2: [{ tools: [{ name: 'file_write', input: skillWriteInput('f2.txt', '不该落盘') }] }, { text: 'F2 完成' }] });
    const file = skillFile(engine.dataDir, 'f2.txt');
    const q = await stream(engine.port, engine.token);
    const other = await wire(engine.port, engine.token);
    const sid = await mkSession(q);
    await send(q, sid, '[[S2]] 写技能目录', 'f06-f2-0001');
    await waitFor('Q 收到权限卡', () => q.cardIds().length === 1);
    const R = q.cardIds()[0];
    const mark = q.applied.length;

    expect((await other.call('chat.sessions.delete', { sessionId: sid, confirm: true })).result).toEqual({ ok: true });
    await waitFor('Q 收到删除后的会话列表广播', () => q.applied.slice(mark).some(f => f.method === 'chat.sessions.changed'));
    const tail = q.applied.slice(mark);
    const resolved = tail.find(f => f.method === 'permission.resolved' && (f.params as any).requestId === R)!;
    const runEnd = tail.find(f => f.method === 'chat.event' && (f.params as any).sessionId === sid && (f.params as any).event?.kind === 'error')!;
    const changed = tail.find(f => f.method === 'chat.sessions.changed')!;
    expect((resolved.params as any).reason).toBe('session-deleted');
    expect(resolved.ev.seq).toBeLessThan(runEnd.ev.seq);
    expect(runEnd.ev.seq).toBeLessThan(changed.ev.seq);
    // 终止事件之后没有这个 run 的任何事件
    expect(tail.filter(f => f.method === 'chat.event' && (f.params as any).sessionId === sid && f.ev.seq > runEnd.ev.seq)).toEqual([]);
    expect(q.cardIds()).toEqual([]);

    const r = await q.attach({ sessionId: sid, forceSnapshot: true });
    if (r.mode !== 'snapshot') throw new Error('应当是快照');
    expect(r.snapshot.sessions.map(s => s.id)).not.toContain(sid);
    expect(r.snapshot.session).toEqual({ sessionId: sid, exists: false, messages: [] });
    expect(r.snapshot.runs.filter(x => x.sessionId === sid)).toEqual([]);
    expect(r.snapshot.live).toEqual([]);
    expect(r.snapshot.pendingPermissions).toEqual([]);
    expect(existsSync(file)).toBe(false);
    expect(q.continuity()).toBeUndefined();
  }, 40_000);
});
