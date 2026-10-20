/**
 * F06：真实引擎上的写调用结果查询、双客户端、认证与取消配对（任务卡验收 3、5；阻断项「重连即重发 pending 写调用」）。
 *
 *  D 组：请求已执行但应答丢失 / 请求根本没送达——客户端不重发，state.outcomes 说得清真实结果；
 *        上行帧由故障代理计数（引擎实际收到几条 chat.prompt / permission.respond）；
 *  G 组：两个客户端看同一个 run 与同一张卡，掐断一个再续传后两边一致、卡只了结一次；
 *        不带 token / 错 token 被拒，pairing 连接调不了 state.*、收不到广播；
 *        已配对设备（真实配对、真实加密通道）取回卡片获得答复资格，取消配对后 state.* 与答复都被守卫拒绝（G5，走 index.ts 的真实装配）。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { WebSocket } from 'ws';
import { InMemoryVault } from '../src/minisd/store/provider-store';
import { readDb } from './run-ledger-fixture';
import { readAudit } from './permission-fixture';
import { wsConnect } from './att-engines-util';
import { RawPeer } from './att-peer-util';
import {
  bootEngine, faultProxy, gatedLlm, hangingMcp, runEventsOf, segs, skillFile, skillWriteInput, streamClient, waitFor, wireClient,
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
async function stream(port: number, token: string): Promise<StreamClient> {
  const c = streamClient(port, token);
  await c.ready;
  cleanups.push(() => c.sock.terminate());
  await c.attach();
  return c;
}
type Caller = { call(method: string, params?: unknown): Promise<WireFrame> };
const mkSession = async (c: Caller): Promise<string> => (await c.call('chat.sessions.create', {})).result.id as string;
const ended = (events: any[]): boolean => events.some(e => e.kind === 'turnEnd' || e.kind === 'error');
const userPromptCount = (dataDir: string, sessionId: string): number =>
  readDb<{ parts_json: string }>(dataDir, "SELECT parts_json FROM messages WHERE session_id=? AND role='user'", sessionId)
    .filter(r => (JSON.parse(r.parts_json) as { type: string }[]).some(p => p.type === 'text')).length;
const runRows = (dataDir: string, sessionId: string): any[] => readDb(dataDir, 'SELECT * FROM agent_runs WHERE session_id=? ORDER BY generation', sessionId);
const execRows = (dataDir: string, sessionId: string): any[] => readDb(dataDir, 'SELECT * FROM tool_executions WHERE session_id=? ORDER BY batch, call_index', sessionId);
const cardOf = (c: Pick<WireClient, 'notifications'>, sessionId: string): WireFrame | undefined =>
  c.notifications.find(n => n.method === 'permission.request' && n.params.req.sessionId === sessionId);
const outcomesOf = async (c: Caller, refs: unknown[]): Promise<any[]> => {
  const r = await c.call('state.outcomes', { refs });
  expect(r.error).toBeUndefined();
  return r.result.outcomes as any[];
};
const LOST = '连接已断开';

describe('F06 D 组：请求已执行但应答丢失 / 请求没送达', () => {
  it('D1 chat.prompt 到了引擎、应答丢了：引擎只收到一次；查询回 accepted 与 run 的真实状态；一条 user 消息、模型请求一次', async () => {
    const { engine, llm } = await boot({ S1: [{ chunks: segs(2) }] });
    const proxy = await faultProxy(engine.port);
    cleanups.push(() => proxy.close());
    const q = await wire(engine.port, engine.token);
    const sid = await mkSession(q);
    const p = await wire(proxy.port, engine.token);
    const promptId = 'f06-d1-0001';
    proxy.forwardThenCut('chat.prompt');
    const lost = await p.call('chat.prompt', { sessionId: sid, text: '[[S1]] 两段', promptId });
    expect(lost.error?.message).toBe(LOST);
    await waitFor('引擎收到并起跑', () => llm.hitsOf('S1').length === 1, 20_000);

    // 重连后的新连接：不重发，先问
    const p2 = await wire(proxy.port, engine.token);
    const ref = { kind: 'prompt', sessionId: sid, promptId };
    const o1 = await outcomesOf(p2, [ref]);
    expect(o1).toHaveLength(1);
    expect(o1[0]).toMatchObject({ kind: 'prompt', sessionId: sid, promptId, status: 'accepted', run: { sessionId: sid, state: 'running', generation: 1, promptId } });
    expect(typeof o1[0].run.userMessageId).toBe('string');
    expect(proxy.countUp('chat.prompt')).toBe(1);

    llm.gate('S1').open();
    await waitFor('回合结束', () => ended(runEventsOf(q, sid)), 20_000);
    const o2 = await outcomesOf(p2, [ref]);
    expect(o2[0]).toMatchObject({ status: 'accepted', run: { state: 'completed', runId: o1[0].run.runId } });
    expect(userPromptCount(engine.dataDir, sid)).toBe(1);
    expect(runRows(engine.dataDir, sid)).toHaveLength(1);
    expect(llm.hitsOf('S1')).toHaveLength(1);
    expect(proxy.countUp('chat.prompt')).toBe(1);
  }, 40_000);

  it('D2 chat.prompt 没到引擎就断了：查询回 not-accepted，库里没有这条消息、没有 run；用同一个 promptId 显式再提交 → 不是 duplicate，正常跑完', async () => {
    const { engine, llm } = await boot({ S1: [{ text: 'D2 完成' }] });
    const proxy = await faultProxy(engine.port);
    cleanups.push(() => proxy.close());
    const q = await wire(engine.port, engine.token);
    const sid = await mkSession(q);
    const p = await wire(proxy.port, engine.token);
    const promptId = 'f06-d2-0001';
    proxy.cutBefore('chat.prompt');
    const lost = await p.call('chat.prompt', { sessionId: sid, text: '[[S1]] 一句', promptId });
    expect(lost.error?.message).toBe(LOST);

    const p2 = await wire(proxy.port, engine.token);
    const o = await outcomesOf(p2, [{ kind: 'prompt', sessionId: sid, promptId }]);
    expect(o).toEqual([{ kind: 'prompt', sessionId: sid, promptId, status: 'not-accepted' }]);
    expect(proxy.countUp('chat.prompt')).toBe(0);
    expect(userPromptCount(engine.dataDir, sid)).toBe(0);
    expect(runRows(engine.dataDir, sid)).toEqual([]);
    expect(llm.hits).toEqual([]);

    // 用户点重试：同一个 promptId
    const again = await p2.call('chat.prompt', { sessionId: sid, text: '[[S1]] 一句', promptId });
    expect(again.result).toMatchObject({ ok: true, duplicate: false, generation: 1, state: 'running' });
    await waitFor('回合结束', () => ended(runEventsOf(q, sid)), 20_000);
    expect(userPromptCount(engine.dataDir, sid)).toBe(1);
    expect(proxy.countUp('chat.prompt')).toBe(1);
    expect((await outcomesOf(p2, [{ kind: 'prompt', sessionId: sid, promptId }]))[0]).toMatchObject({ status: 'accepted', run: { state: 'completed' } });
  }, 40_000);

  it('D3 run 还在 starting（连 MCP）时查询同一个 promptId：应答挂起，不拿一个没落消息的 run 答 accepted；起跑被取消 → not-accepted 带原因；照常起跑 → accepted', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    cleanups.push(() => { warn.mockRestore(); error.mockRestore(); });
    const mcp = await hangingMcp(30);
    cleanups.push(() => mcp.close());
    const { engine } = await boot({ S1: [{ text: 'D3 完成' }] }, { seed: mcp.seed });
    const a = await wire(engine.port, engine.token);
    const b = await wire(engine.port, engine.token);

    // (i) 起跑被取消
    const s1 = await mkSession(a);
    const ref1 = { kind: 'prompt', sessionId: s1, promptId: 'f06-d3-0001' };
    const first = a.call('chat.prompt', { sessionId: s1, text: '[[S1]] 一句', promptId: ref1.promptId });
    await waitFor('run 行已建（starting）', () => runRows(engine.dataDir, s1).length === 1);
    expect(runRows(engine.dataDir, s1)[0]).toMatchObject({ state: 'starting', user_message_id: null });
    let answered: WireFrame | undefined;
    const asking = b.call('state.outcomes', { refs: [ref1] }).then(r => (answered = r));
    // 同一条连接上后发的调用已经有了应答，查询还没有：它确实在等起跑结果，不是慢
    expect((await b.call('chat.sessions.list')).error).toBeUndefined();
    expect(answered).toBeUndefined();
    expect((await a.call('chat.cancel', { sessionId: s1 })).error).toBeUndefined();
    mcp.release();
    const r1 = await first;
    expect(r1.error?.message).toContain('会话已取消');
    await asking;
    expect(answered!.result.outcomes).toHaveLength(1);
    expect(answered!.result.outcomes[0]).toMatchObject({ kind: 'prompt', sessionId: s1, promptId: ref1.promptId, status: 'not-accepted' });
    expect(String(answered!.result.outcomes[0].error)).toContain('会话已取消');
    expect(userPromptCount(engine.dataDir, s1)).toBe(0);
    // 再问一次：行已收尾、id 已放掉 → 仍是 not-accepted（这回不带原因）
    expect(await outcomesOf(b, [ref1])).toEqual([{ ...ref1, status: 'not-accepted' }]);
  }, 60_000);

  it('D3b 同样在 starting 时查询，起跑照常完成：等到 user 消息落库才答 accepted（run 不是 starting）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    cleanups.push(() => { warn.mockRestore(); error.mockRestore(); });
    const mcp = await hangingMcp(30);
    cleanups.push(() => mcp.close());
    const { engine, llm } = await boot({ S1: [{ chunks: segs(1) }] }, { seed: mcp.seed });
    const a = await wire(engine.port, engine.token);
    const b = await wire(engine.port, engine.token);
    const sid = await mkSession(a);
    const ref = { kind: 'prompt', sessionId: sid, promptId: 'f06-d3b-0001' };
    const first = a.call('chat.prompt', { sessionId: sid, text: '[[S1]] 一句', promptId: ref.promptId });
    await waitFor('run 行已建（starting）', () => runRows(engine.dataDir, sid).length === 1);
    let answered: WireFrame | undefined;
    const asking = b.call('state.outcomes', { refs: [ref] }).then(r => (answered = r));
    expect((await b.call('chat.sessions.list')).error).toBeUndefined();
    expect(answered).toBeUndefined();
    mcp.release();
    expect((await first).result).toMatchObject({ ok: true, duplicate: false, state: 'running' });
    await asking;
    expect(answered!.result.outcomes[0]).toMatchObject({ status: 'accepted', run: { state: 'running', sessionId: sid } });
    expect(typeof answered!.result.outcomes[0].run.userMessageId).toBe('string');
    expect(userPromptCount(engine.dataDir, sid)).toBe(1);
    llm.gate('S1').open();
    await waitFor('回合结束', () => ended(runEventsOf(a, sid)), 20_000);
  }, 60_000);

  it('D4 permission.respond 到了引擎、应答丢了：卡已按那次点击了结；重连后应答里没有这张卡，查询回 settled / broker / allow；副作用一次，上行恰一条', async () => {
    const { engine, llm } = await boot({ S1: [{ tools: [{ name: 'file_write', input: skillWriteInput('d4.txt', 'D4 的内容') }] }, { text: 'D4 完成' }] });
    const file = skillFile(engine.dataDir, 'd4.txt');
    const proxy = await faultProxy(engine.port);
    cleanups.push(() => proxy.close());
    const q = await wire(engine.port, engine.token);
    const p = await wire(proxy.port, engine.token);
    const sid = await mkSession(q);
    expect((await q.call('chat.prompt', { sessionId: sid, text: '[[S1]] 写技能目录', promptId: 'f06-d4-0001' })).error).toBeUndefined();
    await waitFor('P 收到权限卡', () => cardOf(p, sid) !== undefined);
    const R = cardOf(p, sid)!.params.requestId as string;

    proxy.forwardThenCut('permission.respond');
    const lost = await p.call('permission.respond', { requestId: R, decision: 'allow-once' });
    expect(lost.error?.message).toBe(LOST);
    await waitFor('回合结束', () => ended(runEventsOf(q, sid)), 20_000);

    const p2 = await wire(proxy.port, engine.token);
    const at = (await p2.call('state.attach', {})).result;
    expect(at.snapshot.pendingPermissions).toEqual([]);
    expect(await outcomesOf(p2, [{ kind: 'permission', requestId: R }])).toEqual([
      { kind: 'permission', requestId: R, status: 'settled', source: 'broker', settled: { reason: 'answered', decision: 'allow' } },
    ]);
    expect(readFileSync(file, 'utf8')).toBe('D4 的内容');
    expect(execRows(engine.dataDir, sid).map(x => [x.state, x.started, x.approval_state])).toEqual([['completed', 1, 'allowed']]);
    expect(proxy.countUp('permission.respond')).toBe(1);
    expect(llm.hitsOf('S1')).toHaveLength(2);
  }, 40_000);

  it('D5 permission.respond 没到引擎就断了：重连后同一张卡仍待批、文件没写；查询回 pending；显式再答 → 生效，写入一次', async () => {
    const { engine } = await boot({ S1: [{ tools: [{ name: 'file_write', input: skillWriteInput('d5.txt', 'D5 的内容') }] }, { text: 'D5 完成' }] });
    const file = skillFile(engine.dataDir, 'd5.txt');
    const proxy = await faultProxy(engine.port);
    cleanups.push(() => proxy.close());
    const q = await wire(engine.port, engine.token);
    const p = await wire(proxy.port, engine.token);
    const sid = await mkSession(q);
    expect((await q.call('chat.prompt', { sessionId: sid, text: '[[S1]] 写技能目录', promptId: 'f06-d5-0001' })).error).toBeUndefined();
    await waitFor('P 收到权限卡', () => cardOf(p, sid) !== undefined);
    const R = cardOf(p, sid)!.params.requestId as string;

    proxy.cutBefore('permission.respond');
    const lost = await p.call('permission.respond', { requestId: R, decision: 'allow-once' });
    expect(lost.error?.message).toBe(LOST);

    const p2 = await wire(proxy.port, engine.token);
    const at = (await p2.call('state.attach', {})).result;
    expect((at.snapshot.pendingPermissions as any[]).map(x => x.requestId)).toEqual([R]);
    expect(await outcomesOf(p2, [{ kind: 'permission', requestId: R }])).toEqual([{ kind: 'permission', requestId: R, status: 'pending', sessionId: sid }]);
    // 那次点击没有到过引擎：一条上行都没有，文件不存在，调用还在审批中
    expect(proxy.countUp('permission.respond')).toBe(0);
    expect(existsSync(file)).toBe(false);
    expect(execRows(engine.dataDir, sid).map(x => x.state)).toEqual(['awaiting-approval']);

    expect((await p2.call('permission.respond', { requestId: R, decision: 'allow-once' })).result).toEqual({ ok: true, applied: true });
    await waitFor('回合结束', () => ended(runEventsOf(q, sid)), 20_000);
    expect(readFileSync(file, 'utf8')).toBe('D5 的内容');
    expect(execRows(engine.dataDir, sid).map(x => [x.state, x.started])).toEqual([['completed', 1]]);
    expect(proxy.countUp('permission.respond')).toBe(1);
  }, 40_000);

  it('D6 查询按真实来源作答：胡编的 id → unknown；用户点过拒绝 → settled / broker / deny；超时 → settled / broker / timeout；入参不合法 → 报错', async () => {
    const { engine } = await boot({
      S1: [{ tools: [{ name: 'file_write', input: skillWriteInput('d6a.txt') }] }, { text: 'ok' }],
      S2: [{ tools: [{ name: 'file_write', input: skillWriteInput('d6b.txt') }] }, { text: 'ok' }],
    }, { permTimeoutMs: 1500 });
    const c = await wire(engine.port, engine.token);
    expect(await outcomesOf(c, [{ kind: 'permission', requestId: 'NO-SUCH-CARD' }])).toEqual([{ kind: 'permission', requestId: 'NO-SUCH-CARD', status: 'unknown' }]);
    const audits = readAudit(engine.dataDir).length;

    // 用户点了拒绝
    const s1 = await mkSession(c);
    expect((await c.call('chat.prompt', { sessionId: s1, text: '[[S1]] 写', promptId: 'f06-d6-0001' })).error).toBeUndefined();
    await waitFor('第一张卡', () => cardOf(c, s1) !== undefined);
    const R1 = cardOf(c, s1)!.params.requestId as string;
    expect((await c.call('permission.respond', { requestId: R1, decision: 'deny' })).result).toEqual({ ok: true, applied: true });
    await waitFor('第一个回合结束', () => ended(runEventsOf(c, s1)), 20_000);
    // 超时（时限 1.5 秒）
    const s2 = await mkSession(c);
    expect((await c.call('chat.prompt', { sessionId: s2, text: '[[S2]] 写', promptId: 'f06-d6-0002' })).error).toBeUndefined();
    await waitFor('第二张卡', () => cardOf(c, s2) !== undefined);
    const R2 = cardOf(c, s2)!.params.requestId as string;
    await waitFor('第二张卡超时', () => c.notifications.some(n => n.method === 'permission.resolved' && n.params.requestId === R2 && n.params.reason === 'timeout'), 15_000);

    expect(await outcomesOf(c, [{ kind: 'permission', requestId: R1 }, { kind: 'permission', requestId: 'NO-SUCH-CARD' }, { kind: 'permission', requestId: R2 }])).toEqual([
      { kind: 'permission', requestId: R1, status: 'settled', source: 'broker', settled: { reason: 'answered', decision: 'deny' } },
      { kind: 'permission', requestId: 'NO-SUCH-CARD', status: 'unknown' },
      { kind: 'permission', requestId: R2, status: 'settled', source: 'broker', settled: { reason: 'timeout', decision: 'deny' } },
    ]);
    expect(existsSync(skillFile(engine.dataDir, 'd6a.txt'))).toBe(false);
    expect(existsSync(skillFile(engine.dataDir, 'd6b.txt'))).toBe(false);
    // 查询不写审计：任意 id 不能刷审计表（上面三次查询没有带来 late-response 之类的行）
    expect(readAudit(engine.dataDir).filter(x => x.eventType === 'permission.late-response')).toEqual([]);
    expect(readAudit(engine.dataDir).length).toBeGreaterThan(audits);

    for (const bad of [{}, { refs: 'x' }, { refs: Array.from({ length: 65 }, () => ({ kind: 'permission', requestId: 'X' })) },
      { refs: [{ kind: 'prompt', sessionId: s1, promptId: 'bad id with spaces' }] }, { refs: [{ kind: 'prompt', sessionId: '../x', promptId: 'ok' }] },
      { refs: [{ kind: 'permission' }] }, { refs: [{ kind: 'input', id: 'x' }] }, { refs: [null] }]) {
      expect((await c.call('state.outcomes', bad)).error, JSON.stringify(bad).slice(0, 60)).toBeDefined();
    }
    // 上限以内的批量照答，顺序与入参一致
    const many = await outcomesOf(c, Array.from({ length: 64 }, (_, i) => ({ kind: 'permission', requestId: `X-${i}` })));
    expect(many.map(o => o.requestId)).toEqual(Array.from({ length: 64 }, (_, i) => `X-${i}`));
  }, 60_000);
});

describe('F06 G 组：双客户端、认证、取消配对', () => {
  it('G1 两个客户端看同一张卡与另一个在流式的 run：掐断一个、期间继续流式、续传回来——尾巴、待批卡、活动 run 一致；一边答复生效，另一边再答得到 settled；副作用一次', async () => {
    const { engine, llm } = await boot({
      S1: [{ tools: [{ name: 'file_write', input: skillWriteInput('g1.txt', 'G1 的内容') }] }, { text: 'G1 完成' }],
      S2: [{ chunks: segs(5) }],
      S3: [{ tools: [{ name: 'file_write', input: skillWriteInput('g1b.txt', '不该落盘') }] }, { text: 'G1b 完成' }],
    });
    const q1 = await stream(engine.port, engine.token);
    const q2 = await stream(engine.port, engine.token);
    const sx = await mkSession(q1);
    const sy = await mkSession(q1);
    expect((await q1.call('chat.prompt', { sessionId: sx, text: '[[S1]] 写技能目录', promptId: 'f06-g1-0001' })).error).toBeUndefined();
    await waitFor('两边都收到卡', () => q1.cardIds().length === 1 && q2.cardIds().length === 1);
    const R = q1.cardIds()[0];
    expect((await q1.call('chat.prompt', { sessionId: sy, text: '[[S2]] 五段', promptId: 'f06-g1-0002' })).error).toBeUndefined();
    const gate = llm.gate('S2');
    gate.release(2);
    await waitFor('两边收到前两段', () => [q1, q2].every(c => c.tailOf(sy)?.text === segs(2).join('')));

    q2.sock.terminate();
    gate.release(2);
    await waitFor('Q1 收到前四段', () => q1.tailOf(sy)?.text === segs(4).join(''));
    const r2 = await q2.reconnect(engine.port, engine.token);
    expect(r2.mode).toBe('resume');
    const r1 = await q1.attach();
    expect(r1.mode).toBe('resume');
    if (r1.mode !== 'resume' || r2.mode !== 'resume') throw new Error('应当是续传');
    expect(q2.tails()).toEqual(q1.tails());
    expect(q2.tailOf(sy)?.text).toBe(segs(4).join(''));
    expect(q2.cardIds()).toEqual([R]);
    expect(q1.cardIds()).toEqual([R]);
    const active = (runs: any[]): string[] => runs.filter(x => x.state === 'running' || x.state === 'starting').map(x => x.runId as string).sort();
    expect(active(r2.runs)).toEqual(active(r1.runs));
    expect(active(r2.runs)).toHaveLength(2);

    // 续传回来的 Q2 答复：生效；Q1 的卡消失，再答得到 settled
    expect((await q2.call('permission.respond', { requestId: R, decision: 'allow-once' })).result).toEqual({ ok: true, applied: true });
    await waitFor('Q1 收到了结', () => q1.cardIds().length === 0);
    expect((await q1.call('permission.respond', { requestId: R, decision: 'deny' })).result).toEqual({ ok: true, applied: false, settled: { reason: 'answered', decision: 'allow' } });
    await waitFor('写技能目录的回合结束', () => ended(q1.eventsOf(sx)) && ended(q2.eventsOf(sx)), 20_000);
    expect(readFileSync(skillFile(engine.dataDir, 'g1.txt'), 'utf8')).toBe('G1 的内容');
    expect(execRows(engine.dataDir, sx).map(x => [x.state, x.started])).toEqual([['completed', 1]]);

    // 反过来：另一张卡，一直连着的 Q1 先答（拒绝），续传回来的 Q2 再答 → settled，文件没写
    const sz = await mkSession(q1);
    expect((await q1.call('chat.prompt', { sessionId: sz, text: '[[S3]] 写技能目录', promptId: 'f06-g1-0003' })).error).toBeUndefined();
    await waitFor('两边都收到第二张卡', () => q1.cardIds().length === 1 && q2.cardIds().length === 1);
    const R2 = q1.cardIds()[0];
    expect((await q1.call('permission.respond', { requestId: R2, decision: 'deny' })).result).toEqual({ ok: true, applied: true });
    await waitFor('Q2 收到了结', () => q2.cardIds().length === 0);
    expect((await q2.call('permission.respond', { requestId: R2, decision: 'allow-once' })).result).toEqual({ ok: true, applied: false, settled: { reason: 'answered', decision: 'deny' } });
    await waitFor('第二个写入回合结束', () => ended(q1.eventsOf(sz)), 20_000);
    expect(existsSync(skillFile(engine.dataDir, 'g1b.txt'))).toBe(false);

    gate.open();
    await waitFor('流式回合结束', () => ended(q1.eventsOf(sy)) && ended(q2.eventsOf(sy)), 20_000);
    expect(q2.tails()).toEqual(q1.tails());
    expect(q1.continuity()).toBeUndefined();
    expect(q2.continuity()).toBeUndefined();
    expect(llm.hitsOf('S2')).toHaveLength(1);
  }, 60_000);

  it('G2 认证：不带 token、错 token 在握手阶段被 401；pairing 连接调 state.attach / state.outcomes 被拒，收不到任何广播', async () => {
    const { engine } = await boot();
    const status = (url: string): Promise<number | 'open'> => new Promise(resolve => {
      const ws = new WebSocket(url);
      ws.on('unexpected-response', (_req, res) => { resolve(res.statusCode ?? 0); try { ws.terminate(); } catch { /* 已关 */ } });
      ws.on('open', () => { resolve('open'); ws.terminate(); });
      ws.on('error', () => undefined);
    });
    expect(await status(`ws://127.0.0.1:${engine.port}/`)).toBe(401);
    expect(await status(`ws://127.0.0.1:${engine.port}/?token=WRONG-TOKEN`)).toBe(401);

    const local = await wire(engine.port, engine.token);
    const begin = (await local.call('remote.pair.begin', {})).result;
    expect(typeof begin.pairingCode).toBe('string');
    // 只拿着配对码的连接（pairing 模式）
    const frames: any[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${engine.port}/?pairingCode=${encodeURIComponent(begin.pairingCode)}`);
    cleanups.push(() => ws.terminate());
    ws.on('message', d => frames.push(JSON.parse(String(d))));
    await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
    const callP = async (id: number, method: string, params: unknown): Promise<any> => {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      await waitFor(`pairing 连接收到 ${method} 的应答`, () => frames.some(f => f.id === id));
      return frames.find(f => f.id === id);
    };
    const a = await callP(1, 'state.attach', {});
    expect(a.result).toBeUndefined();
    expect(String(a.error?.message)).toContain('pairing');
    const s = await mkSession(local);
    for (let i = 0; i < 3; i++) expect((await local.call('chat.sessions.rename', { sessionId: s, title: `G2 ${i}` })).error).toBeUndefined();
    await waitFor('local 收到三条广播', () => local.notifications.filter(n => n.method === 'chat.sessions.changed').length >= 3);
    const o = await callP(2, 'state.outcomes', { refs: [] });
    expect(String(o.error?.message)).toContain('pairing');
    // 它的两个应答之间引擎发过三条广播：一条都没到它这里
    expect(frames.filter(f => f.method !== undefined || f.ev !== undefined)).toEqual([]);
    expect(frames).toHaveLength(2);
  }, 40_000);

  // 变异检查补的：index.ts 里 state.attach 的 sessionId 与别的业务方法一样先过 assertSessionId（state.outcomes 那一边 D6 钉着）。
  // 把这道校验去掉，原有用例全绿——形状不对的 id 会被当成「会话已不存在」答回去，渲染端据此落到欢迎页
  it('G2b state.attach 的入参校验（真实装配）：sessionId 形状不对 → 报错、不给快照；形状对而库里没有 → exists:false；不是字符串按没带处理', async () => {
    const { engine } = await boot();
    const c = await wire(engine.port, engine.token);
    const sid = await mkSession(c);
    for (const bad of ['../x', 'nope', '', `${sid}/..`, ` ${sid}`]) {
      const r = await c.call('state.attach', { sessionId: bad });
      expect(r.error?.message, JSON.stringify(bad)).toBe('非法 sessionId');
      expect(r.result, JSON.stringify(bad)).toBeUndefined();
    }
    const ok = await c.call('state.attach', { sessionId: sid });
    expect(ok.error).toBeUndefined();
    expect(ok.result.snapshot.session).toEqual({ sessionId: sid, exists: true, messages: [] });
    const ghost = '00000000-0000-4000-8000-000000000000'; // 形状合法、库里没有这个会话
    const none = await c.call('state.attach', { sessionId: ghost });
    expect(none.error).toBeUndefined();
    expect(none.result.snapshot.session).toEqual({ sessionId: ghost, exists: false, messages: [] });
    const untyped = await c.call('state.attach', { sessionId: 42 });
    expect(untyped.error).toBeUndefined();
    expect(untyped.result.mode).toBe('snapshot');
    expect(untyped.result.snapshot.session).toBeUndefined();
  }, 30_000);

  it('G5 真实引擎上的已配对设备：发卡之后才连上的对端经 state.attach 取回卡片并登记；remote.unpair 当场断开它；不经 remote.unpair 删掉配对记录后，state.attach / state.outcomes / permission.respond 都被守卫拒绝、回包后连接关闭，卡不动、没有新的补发审计', async () => {
    const { engine } = await boot({ S1: [{ tools: [{ name: 'file_write', input: skillWriteInput('g5.txt', 'G5 的内容') }] }, { text: 'G5 完成' }] });
    const file = skillFile(engine.dataDir, 'g5.txt');
    const local = await wire(engine.port, engine.token);
    const admin = await wsConnect(`ws://127.0.0.1:${engine.port}/?token=${encodeURIComponent(engine.token)}`);
    cleanups.push(() => admin.close());
    const sid = await mkSession(local);
    expect((await local.call('chat.prompt', { sessionId: sid, text: '[[S1]] 写技能目录', promptId: 'f06-g5-0001' })).error).toBeUndefined();
    await waitFor('本机收到权限卡', () => cardOf(local, sid) !== undefined);
    const R = cardOf(local, sid)!.params.requestId as string;
    const redelivered = (): any[] => readAudit(engine.dataDir).filter(x => x.eventType === 'permission.redelivered');
    const pendingNow = async (): Promise<string[]> => ((await local.call('state.attach', {})).result.snapshot.pendingPermissions as any[]).map(x => x.requestId as string);
    /** 触发一条广播并等本机收到：此前排给别的连接的帧（若有）一定已经发出。 */
    let renames = 0;
    const pulse = async (): Promise<void> => {
      const n = local.notifications.filter(x => x.method === 'chat.sessions.changed').length;
      expect((await local.call('chat.sessions.rename', { sessionId: sid, title: `G5 ${++renames}` })).error).toBeUndefined();
      await waitFor('本机收到改名的广播', () => local.notifications.filter(x => x.method === 'chat.sessions.changed').length > n);
    };

    // 对端一：真实配对、真实加密通道；卡是它连上之前发的
    const peer1 = new RawPeer();
    cleanups.push(() => peer1.dispose());
    await peer1.pair(admin, engine.port);
    const c1 = await peer1.connect();
    const at1 = await c1.call('state.attach', {});
    expect(at1.mode).toBe('snapshot');
    expect((at1.snapshot.pendingPermissions as any[]).map(x => x.requestId)).toEqual([R]);
    expect(at1.snapshot.pendingPermissions[0].req).toEqual(cardOf(local, sid)!.params.req);
    expect(redelivered()).toHaveLength(1);
    expect(redelivered()[0]).toMatchObject({ sessionId: sid, peerFingerprint: peer1.fp, payload: { requestId: R, by: 'remote' } });
    // 配对着的时候它照常收广播（下面「取消配对之后收不到」才有意义）
    await pulse();
    await waitFor('对端收到改名的广播', () => c1.notifications.some(n => n.method === 'chat.sessions.changed'));

    // (a) 本机取消配对：对端的连接当场被关；卡仍待批；之后的广播到不了它
    await admin.call('remote.unpair', { peerFingerprint: peer1.fp });
    await c1.closed;
    const seen1 = c1.notifications.length;
    expect(await pendingNow()).toEqual([R]);
    await pulse();
    expect(c1.notifications.length).toBe(seen1);

    // (b) 对端二：三条连接都先 attach（各登记一次），然后不经 remote.unpair 删它的配对记录——连接还在，轮到业务守卫来拦
    const peer2 = new RawPeer();
    cleanups.push(() => peer2.dispose());
    await peer2.pair(admin, engine.port);
    const k = [await peer2.connect(), await peer2.connect(), await peer2.connect()];
    for (const c of k) expect(((await c.call('state.attach', {})).snapshot.pendingPermissions as any[]).map(x => x.requestId)).toEqual([R]);
    const audited = redelivered().length;
    expect(audited).toBe(4);
    InMemoryVault.forDataRoot(engine.dataDir).delete('pairing.' + peer2.fp);

    await expect(k[0].call('state.attach', {})).rejects.toThrow(/配对/);
    await k[0].closed;
    await expect(k[1].call('state.outcomes', { refs: [{ kind: 'permission', requestId: R }] })).rejects.toThrow(/配对/);
    await k[1].closed;
    await expect(k[2].call('permission.respond', { requestId: R, decision: 'allow-once' })).rejects.toThrow(/配对/);
    await k[2].closed;
    const seen2 = k.map(c => c.notifications.length);
    expect(await pendingNow()).toEqual([R]);
    expect(existsSync(file)).toBe(false);
    expect(redelivered().length).toBe(audited);
    expect(readAudit(engine.dataDir).filter(x => x.eventType === 'permission.resolved' && x.payload.requestId === R)).toEqual([]);
    await pulse();
    expect(k.map(c => c.notifications.length)).toEqual(seen2);

    // 本机（发卡时已连着）答复：生效，写入一次
    expect((await local.call('permission.respond', { requestId: R, decision: 'allow-once' })).result).toEqual({ ok: true, applied: true });
    await waitFor('回合结束', () => ended(runEventsOf(local, sid)), 20_000);
    expect(readFileSync(file, 'utf8')).toBe('G5 的内容');
    expect(execRows(engine.dataDir, sid).map(x => [x.state, x.started])).toEqual([['completed', 1]]);
  }, 90_000);
});
