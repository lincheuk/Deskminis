/**
 * F06 先红基线：四条用例在 F06 之前的基线上是红的（红在行为上），实现之后变绿。本文件的文本此后不再改。
 *
 * 只用真实引擎（进程内起）、真实 WebSocket 与现有的渲染端 RpcClient；不引任何 F06 新增的 src 模块，
 * 所以在基线上也跑得起来：
 *  R1 广播帧没有序号——客户端分不清重复、漏帧、乱序；
 *  R2 卡片待批时换一条连接：新连接答不了这张卡（F13 的 undelivered），也没有办法取回它；
 *  R3 流到一半的正文只存在于已经发出去的增量里，新连接无处可取；
 *  R4 渲染端断线即终态，引擎回来了也不恢复。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { WebSocket as WsClient } from 'ws';
import { readDb } from './run-ledger-fixture';
import { bootEngine, gatedLlm, seg, segs, skillFile, skillWriteInput, waitFor, wireClient, publishedText, runEventsOf, type BootedEngine, type GatedLlm, type GatedStep, type WireClient } from './state-sync-fixture';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) { try { await f(); } catch { /* 收尾尽力 */ } }
});

async function boot(scripts: Record<string, GatedStep[]> = {}): Promise<{ engine: BootedEngine; llm: GatedLlm }> {
  const llm = await gatedLlm(scripts);
  cleanups.push(() => llm.close());
  const engine = await bootEngine({ llm });
  cleanups.push(() => engine.close());
  return { engine, llm };
}
async function wire(engine: BootedEngine): Promise<WireClient> {
  const c = wireClient(engine.port, engine.token);
  await c.ready;
  cleanups.push(() => c.close());
  return c;
}

describe('F06 先红基线', () => {
  it('R1 每条广播帧带 ev { epoch, seq }，同一条连接上 seq 逐一递增、epoch 不变', async () => {
    const { engine } = await boot();
    const c = await wire(engine);
    const s = (await c.call('chat.sessions.create', {})).result;
    for (let i = 0; i < 5; i++) expect((await c.call('chat.sessions.rename', { sessionId: s.id, title: `标题 ${i}` })).error).toBeUndefined();
    await waitFor('五条 chat.sessions.changed', () => c.notifications.filter(n => n.method === 'chat.sessions.changed').length === 5);

    const stamps = c.notifications.map(n => n.ev);
    expect(stamps.length).toBeGreaterThanOrEqual(5);
    // 每一条都带戳
    expect(stamps.filter(ev => ev === undefined || !Number.isSafeInteger(ev.seq) || !Number.isSafeInteger(ev.epoch))).toEqual([]);
    // 同一代次、逐一递增（没有空洞、没有重复）
    expect(new Set(stamps.map(ev => ev!.epoch)).size).toBe(1);
    for (let i = 1; i < stamps.length; i++) expect(stamps[i]!.seq).toBe(stamps[i - 1]!.seq + 1);
    // params 与以前逐字相同：戳在帧顶层，不在 params 里
    expect(c.notifications.filter(n => n.method === 'chat.sessions.changed').map(n => n.params)).toEqual([{}, {}, {}, {}, {}]);
  }, 30_000);

  it('R2 卡片待批时新开一条连接：state.attach 把同一张卡交给它，随后它的答复生效，工具恰好执行一次', async () => {
    const { engine, llm } = await boot({ S1: [{ tools: [{ name: 'file_write', input: skillWriteInput('r2.txt', 'R2 的内容') }] }, { text: 'R2 完成' }] });
    const file = skillFile(engine.dataDir, 'r2.txt');
    const a = await wire(engine);
    const s = (await a.call('chat.sessions.create', {})).result;
    expect((await a.call('chat.prompt', { sessionId: s.id, text: '[[S1]] 写技能目录', promptId: 'f06-r2-0001' })).error).toBeUndefined();
    await waitFor('A 收到权限卡', () => a.notifications.some(n => n.method === 'permission.request' && n.params.req.sessionId === s.id));
    const card = a.notifications.find(n => n.method === 'permission.request' && n.params.req.sessionId === s.id)!;
    const requestId: string = card.params.requestId;
    expect(existsSync(file)).toBe(false);

    // B 是发卡之后才建立的连接（重载后的窗口、重连后的套接字）
    const b = await wire(engine);
    const attached = await b.call('state.attach', {});
    expect(attached.error).toBeUndefined();
    const cards: any[] = attached.result.mode === 'snapshot' ? attached.result.snapshot.pendingPermissions : attached.result.pendingPermissions;
    expect(cards.map(x => x.requestId)).toEqual([requestId]);
    expect(cards[0].req).toEqual(card.params.req);

    const answer = await b.call('permission.respond', { requestId, decision: 'allow-once' });
    expect(answer.error).toBeUndefined();
    expect(answer.result).toEqual({ ok: true, applied: true });
    await waitFor('回合结束', () => runEventsOf(a, s.id).some(e => e.kind === 'turnEnd'), 20_000);

    // 副作用恰好一次：文件在、内容对；账本里这次调用一行、已完成；模型被请求两次（工具回合 + 收尾回合）
    expect(readFileSync(file, 'utf8')).toBe('R2 的内容');
    expect(readDb(engine.dataDir, 'SELECT state, started FROM tool_executions WHERE session_id=?', s.id)).toEqual([{ state: 'completed', started: 1 }]);
    expect(llm.hitsOf('S1')).toHaveLength(2);
    expect(readDb(engine.dataDir, "SELECT COUNT(*) n FROM messages WHERE session_id=? AND role='user' AND parts_json LIKE '%[[S1]]%'", s.id)).toEqual([{ n: 1 }]);
  }, 40_000);

  it('R3 流式中途新开一条连接：state.attach 的快照里有这次运行已经发布的正文，之后的增量接着来', async () => {
    const { engine, llm } = await boot({ S2: [{ chunks: segs(4) }] });
    const a = await wire(engine);
    const s = (await a.call('chat.sessions.create', {})).result;
    expect((await a.call('chat.prompt', { sessionId: s.id, text: '[[S2]] 分四段回答', promptId: 'f06-r3-0001' })).error).toBeUndefined();
    llm.gate('S2').release(2);
    await waitFor('A 收到前两段', () => publishedText(a, s.id) === seg(0) + seg(1));

    const b = await wire(engine);
    const attached = await b.call('state.attach', { sessionId: s.id });
    expect(attached.error).toBeUndefined();
    expect(attached.result.mode).toBe('snapshot');
    const snap = attached.result.snapshot;
    const tail = (snap.live as any[]).find(x => x.sessionId === s.id);
    expect(tail?.text).toBe(seg(0) + seg(1));
    expect((snap.runs as any[]).find(r => r.sessionId === s.id)?.state).toBe('running');

    llm.gate('S2').open();
    await waitFor('回合结束', () => runEventsOf(b, s.id).some(e => e.kind === 'turnEnd'), 20_000);
    // 快照里的尾巴 + 之后收到的增量 = 库里的全文，一段不多、一段不少
    const full = segs(4).join('');
    expect(tail.text + publishedText(b, s.id)).toBe(full);
    const stored = readDb<{ parts_json: string }>(engine.dataDir, "SELECT parts_json FROM messages WHERE session_id=? AND role='assistant'", s.id);
    expect(stored).toHaveLength(1);
    expect((JSON.parse(stored[0].parts_json) as { type: string; value: unknown }[]).filter(p => p.type === 'text').map(p => p.value).join('')).toBe(full);
    expect(llm.hitsOf('S2')).toHaveLength(1);
  }, 40_000);

  it('R4 开启恢复的渲染端 RpcClient：引擎重启（新 token）之后自动重连，调用恢复可用', async () => {
    const { engine } = await boot();
    const g = globalThis as any;
    const saved = { WebSocket: g.WebSocket, window: g.window };
    cleanups.push(() => { g.WebSocket = saved.WebSocket; g.window = saved.window; });
    // 重连时渲染端重新向主进程要端口与 token；引擎没起来之前这一问先挂着（不靠退避时长猜引擎什么时候回来）
    let engineUp: Promise<void> = Promise.resolve();
    g.WebSocket = WsClient;
    g.window = { deskminis: { minisdInfo: async () => { await engineUp; return engine.info(); } } };
    const { RpcClient } = await import('../src/renderer/src/rpc');
    const c: any = new RpcClient();
    cleanups.push(() => { try { c.ws?.close(); } catch { /* 已关 */ } });
    // store 在 init() 里做的两步；基线上没有这两个方法（断线即终态）
    c.enableRecovery?.(
      { attachParams: () => ({}), applySnapshot: () => undefined, resumed: () => undefined },
      { policy: { delaysMs: [20, 20, 40, 40, 80, 80, 160, 160], jitter: 0, probeIdleMs: 0 } },
    );
    await c.connect();
    await c.resync?.('initial');
    expect(await c.call('chat.sessions.list')).toEqual([]);

    let up!: () => void;
    engineUp = new Promise<void>(r => { up = r; });
    const tokenBefore = engine.token;
    await engine.restart();
    expect(engine.token).not.toBe(tokenBefore);
    up();

    let last = '';
    await waitFor('引擎回来之后调用恢复可用', async () => {
      try { await c.call('chat.sessions.list'); return true; } catch (e) { last = String(e); return false; }
    }, 8_000).catch(() => { throw new Error(`引擎已经重启并可连接，渲染端的调用仍然被拒绝：${last}`); });
    const made = await c.call('chat.sessions.create', {});
    expect(typeof made.id).toBe('string');
  }, 40_000);
});
