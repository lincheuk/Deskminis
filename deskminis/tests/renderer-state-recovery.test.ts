/**
 * F06 O 组：渲染端 store 的快照重建、续传校正、重连之后的收敛与在途写调用的核对（设计 §4.9）。
 *
 * store 是真的；rpc 是带恢复钩子的桩：enableRecovery 记下 store 给的钩子，用例按 rpc 的调用顺序自己调
 * （status('open') → 回放帧 → resumed → synced），resync 用用例给的快照调 applySnapshot。
 *
 * 钉的行为（都落在状态与调用序列上）：
 *  - 快照重建：运行集合（别处的 starting 不点亮、本窗口自己的保留、在途提交不被摘）、待批卡、历史 + 尾巴、会话已删；
 *  - 收口只认本窗口正跟踪的那一次 run，同一次 run 只交代一次；
 *  - 晚到事件：已结束的 run、更早的 run、别的代次、已消失的会话都不复活运行条；
 *  - 重连期间不清运行态、不发任何调用；重连后不分续传还是快照都重取当前会话并整体刷新；
 *  - 在途的发送与权限答复：只查询（state.outcomes），用户点按钮之前调用序列里没有 chat.prompt / permission.respond；
 *  - 尾巴模式：不建步骤卡；消息落库后重取历史并切掉缓冲里已落库的部分，同一段文字只出现一次。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { rpcCallMock, resyncMock, retryNowMock, handlers, box } = vi.hoisted(() => ({
  rpcCallMock: vi.fn(),
  resyncMock: vi.fn(),
  retryNowMock: vi.fn(),
  handlers: new Map<string, (p: any) => void>(),
  box: {} as {
    hooks?: any; onLost?: () => void;
    sessions: any[]; history: Record<string, any[]>;
    initial?: any; join?: () => any;
    prompt?: () => Promise<any>; outcomes?: (refs: any[]) => any; respond?: () => Promise<any>;
    lists?: Record<string, () => Promise<any>>;
  },
}));

vi.mock('../src/renderer/src/rpc', () => ({
  rpc: {
    call: rpcCallMock,
    connect: async () => {},
    on: (method: string, h: (p: any) => void) => { handlers.set(method, h); },
    onLost: (h: () => void) => { box.onLost = h; },
    enableRecovery: (hooks: any) => { box.hooks = hooks; },
    resync: resyncMock,
    retryNow: retryNowMock,
  },
}));

// eslint-disable-next-line import/first —— vi.mock 由 vitest 提升到顶部
import { createPinia, setActivePinia } from 'pinia';
// eslint-disable-next-line import/first
import { useChat } from '../src/renderer/src/stores/chat';
// eslint-disable-next-line import/first
import { isWriteMethod, markInFlightLoss } from '../src/renderer/src/lib/conn/in-doubt';
// eslint-disable-next-line import/first
import { permOutcomeNote } from '../src/renderer/src/lib/perm/copy';

const LOST = '与后台服务的连接已断开';
const inFlight = (): Error => markInFlightLoss(new Error(LOST));
/** 排空：桩的应答都在微任务里，转几圈宏任务让 afterSync 这类没人等的异步走完。 */
const drain = async (): Promise<void> => { for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0)); };

const run = (o: Record<string, unknown> = {}) => ({
  runId: 'r1', sessionId: 'A', generation: 1, epoch: 1, state: 'running', step: 'model', toolBatches: 0,
  origin: { kind: 'user' }, createdAt: 1, updatedAt: 1, ...o,
});
const permView = (o: Record<string, unknown> = {}) => ({
  requestId: 'R1',
  req: { sessionId: 'A', kind: 'file-write', detail: '写 a.txt', toolTitle: '写文件', preview: { oldText: '旧', newText: '新' }, note: '改应用配置' },
  meta: { timeoutMs: 90_000, riskClass: 'high', bridgeTriggers: ['web-fetch'], toolUseId: 'tu1' },
  origin: 'tool', askedAt: 1, remainingMs: 30_000, ...o,
});
const snap = (o: Record<string, unknown> = {}) => ({
  epoch: 1, instanceId: 'I', revision: 1, lastSeq: 10, takenAt: 0, sessions: box.sessions,
  runs: [] as any[], executions: [], live: [] as any[], pendingPermissions: [] as any[], artifacts: [] as any[], ...o,
});
const msg = (id: string, role: string, text: string) => ({ id, role, parts: [{ type: 'text', value: text }], createdAt: 1 });
const evt = (sessionId: string, event: Record<string, unknown>, r: Record<string, unknown> = {}) =>
  ({ sessionId, event, run: { id: 'r1', generation: 1, epoch: 1, ...r } });
const emit = (sessionId: string, event: Record<string, unknown>, r?: Record<string, unknown>): void => handlers.get('chat.event')!(evt(sessionId, event, r));
const callsOf = (method: string): any[] => rpcCallMock.mock.calls.filter(c => c[0] === method).map(c => c[1]);
const methods = (): string[] => rpcCallMock.mock.calls.map(c => String(c[0]));
const notes = (chat: any): string[] => chat.eventNotes.map((n: any) => n.short ?? n.detail);

beforeEach(() => {
  handlers.clear();
  rpcCallMock.mockReset(); resyncMock.mockReset(); retryNowMock.mockReset();
  box.hooks = undefined; box.onLost = undefined;
  box.sessions = [{ id: 'A', title: 'A' }, { id: 'B', title: 'B' }];
  box.history = { A: [msg('a1', 'user', '上一条'), msg('a2', 'assistant', '上一条的回答')], B: [msg('b1', 'user', 'B 的消息')] };
  box.initial = undefined; box.join = undefined; box.prompt = undefined; box.outcomes = undefined; box.respond = undefined; box.lists = undefined;
  rpcCallMock.mockImplementation(async (method: string, params: any) => {
    if (box.lists?.[method]) return box.lists[method]();
    if (method === 'permission.getPreset') return { preset: 'ask' };
    if (method === 'chat.sessions.list') return box.sessions;
    if (method === 'provider.instances.list' || method === 'modelgroup.list' || method === 'assistants.list' || method === 'skills.list' || method === 'cron.list') return [];
    if (method === 'provider.getDefault') return {};
    if (method === 'control.status') return { syncPaused: false };
    // 每次给一份新数组：store 往 messages 里 push 乐观气泡时不能改到这里的「库」
    if (method === 'chat.messages.list') return [...(box.history[params.sessionId] ?? [])];
    if (method === 'chat.annotations.list') return { annotations: [] };
    if (method === 'workspace.get') return { root: '/w', isDefault: true };
    if (method === 'chat.prompt') return box.prompt ? box.prompt() : { ok: true, runId: 'r-new', generation: 9, duplicate: false, state: 'running' };
    if (method === 'permission.respond') return box.respond ? box.respond() : { ok: true, applied: true };
    if (method === 'state.outcomes') return { epoch: 1, instanceId: 'I', outcomes: box.outcomes ? box.outcomes(params.refs) : [] };
    return undefined;
  });
  resyncMock.mockImplementation(async (cause: string = 'join') => {
    const s = cause === 'initial' ? (box.initial ?? snap()) : box.join?.();
    if (!s) throw new Error('取不到快照');
    box.hooks.applySnapshot(s, { reason: 'no-cursor', cause, epochChanged: false });
    box.hooks.synced?.({ via: 'snapshot', cause, epochChanged: false, revision: s.revision, missed: false, inDoubt: [] });
  });
});
afterEach(() => { vi.useRealTimers(); delete (globalThis as any).sessionStorage; });

describe('F03 integrate: disappearance clears recovery and compact detail', () => {
  for (const via of ['snapshot', 'lifecycle']) {
    it(`clears the deleted session's recovery cards when ${via} lands on welcome`, async () => {
      const chat = await boot({ active: 'A' });
      chat.contextRecoveryState = { marker: 'A-recovery' } as any;
      chat.compactionDetail = { markerId: 'A-compact' } as any;
      box.sessions = [];
      if (via === 'snapshot') {
        box.hooks.applySnapshot(snap({ sessions: [], session: { sessionId: 'A', exists: false, messages: [] } }),
          { reason: 'no-cursor', cause: 'reconnect', epochChanged: false });
      } else {
        await chat.onSessionLifecycle({ sessionId: 'A', kind: 'deleted', origin: 'local', v: 1, byDevice: 'local' });
      }
      await drain();
      expect(chat.activeId).toBe('');
      expect(chat.contextRecoveryState).toBeNull();
      expect(chat.compactionDetail).toBeNull();
    });
  }
});

describe('F06 close: context response belongs to the requested session', () => {
  for (const next of ['B', '']) {
    it(`discards delayed context for A after switching to ${next || 'welcome'}`, async () => {
      const chat = await boot({ active: 'A' });
      let release!: (value: any) => void;
      const pending = new Promise(resolve => { release = resolve; });
      box.lists = { 'chat.contextInfo': () => pending };
      const request = chat.fetchContextInfo();
      expect(callsOf('chat.contextInfo').at(-1)).toEqual({ sessionId: 'A' });
      if (next) await chat.open(next);
      else chat.dropToWelcome();
      const current = { marker: 'current-session' } as any;
      chat.contextInfo = current;
      release({ marker: 'deleted-A' });
      await request;
      expect(chat.activeId).toBe(next);
      expect(chat.contextInfo).toEqual(current);
    });
  }
  it('accepts context while the requested session is still active', async () => {
    const chat = await boot({ active: 'A' });
    box.lists = { 'chat.contextInfo': async () => ({ marker: 'A' }) };
    await chat.fetchContextInfo();
    expect(chat.contextInfo).toEqual({ marker: 'A' });
  });
});

async function boot(o: { initial?: Record<string, unknown>; active?: string } = {}) {
  setActivePinia(createPinia());
  // 同一条用例里再 boot 一次（「重载」、对照组）时，上一个 store 的桩行为不带过来
  box.join = undefined; box.prompt = undefined; box.outcomes = undefined; box.respond = undefined; box.lists = undefined;
  box.initial = snap(o.initial);
  const chat = useChat();
  await chat.init();
  if (o.active) await chat.open(o.active);
  await drain();
  rpcCallMock.mockClear(); resyncMock.mockClear();
  return chat;
}
/** 带当前会话的快照（join 用）：历史取 box.history，其余由用例给。 */
const joinSnap = (chat: any, o: Record<string, unknown> = {}) => (): any => snap({
  session: { sessionId: chat.activeId, exists: true, messages: [...(box.history[chat.activeId] ?? [])] }, ...o,
});
/** 按 rpc 的顺序走一遍「重连 → 续传」：开闸通知、回放帧、校正、收尾。 */
function reconnectResume(o: { events?: any[]; runs?: any[]; perms?: any[]; inDoubt?: any[]; revision?: number; cause?: string; missed?: boolean; skipOpen?: boolean } = {}): void {
  if (!o.skipOpen) box.hooks.status({ state: 'open', attempt: 0, maxAttempts: 8 });
  for (const e of o.events ?? []) handlers.get(e.method)!(e.params);
  const r = { protocol: 1, epoch: 1, instanceId: 'I', lastSeq: 20, revision: o.revision ?? 1, window: { firstSeq: 1, maxEvents: 1, maxChars: 1 },
    mode: 'resume', events: o.events ?? [], runs: o.runs ?? [], pendingPermissions: o.perms ?? [] };
  box.hooks.resumed(r, { cause: o.cause ?? 'reconnect' });
  box.hooks.synced({ via: 'resume', cause: o.cause ?? 'reconnect', epochChanged: false, revision: r.revision, missed: o.missed === true, inDoubt: o.inDoubt ?? [] });
}
const goReconnecting = (): void => box.hooks.status({ state: 'reconnecting', attempt: 1, maxAttempts: 8, retryInMs: 500 });

describe('F06 O 组 · 快照重建', () => {
  it('运行集合：running 的点亮；别处的 starting 不点亮、记进 pendingStarts 并让探测走 poll；待批卡按剩余时间算倒计时', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    const chat = await boot({ initial: {
      runs: [run({ runId: 'rA', sessionId: 'A', state: 'running' }), run({ runId: 'rB', sessionId: 'B', state: 'starting', generation: 3 }), run({ runId: 'old', sessionId: 'B', epoch: 0, state: 'running' })],
      pendingPermissions: [permView()],
    } });
    expect(chat.syncOn).toBe(true);
    expect(chat.runningSessions).toEqual(['A']);                 // 别处正在起跑的 B 不点亮；前代残留的活动行不算
    expect(chat.pendingStarts).toEqual({ B: { runId: 'rB', since: 1_000_000 } });
    expect(chat.runOf.B).toBeUndefined();                        // 没点亮的 starting 不算本窗口在跟踪
    expect(box.hooks.wantProbe()).toBe('poll');
    expect(chat.pendingPerms.map(p => [p.requestId, p.sessionId, p.deadlineMs])).toEqual([['R1', 'A', 1_030_000]]);
    // 陈旧的 starting 行不该让探测一直转：超过 120 秒不再 poll（还有活动 run 与卡，退回 idle）
    vi.setSystemTime(1_000_000 + 120_001);
    expect(box.hooks.wantProbe()).toBe('idle');
  });

  it('pendingStarts：续传应答把它报成 running → 点亮、表清空，是当前会话则取一次带会话的快照；应答里它消失 → 表清空、始终没点亮', async () => {
    const chat = await boot({ initial: { runs: [run({ runId: 'rA', sessionId: 'A', state: 'starting' })] }, active: 'A' });
    expect(chat.running).toBe(false);
    expect(chat.pendingStarts.A?.runId).toBe('rA');
    box.join = joinSnap(chat, { runs: [run({ runId: 'rA', sessionId: 'A', state: 'running', userMessageId: 'a3' })] });
    box.history.A = [...box.history.A, msg('a3', 'user', '别处发的')];
    reconnectResume({ cause: 'probe', runs: [run({ runId: 'rA', sessionId: 'A', state: 'running' })], skipOpen: true });
    await drain();
    expect(chat.runningSessions).toEqual(['A']);
    expect(chat.pendingStarts).toEqual({});
    expect(chat.running).toBe(true);
    expect(resyncMock).toHaveBeenCalledWith('join');
    expect(chat.messages.map(m => m.id)).toEqual(['a1', 'a2', 'a3']); // 历史里有那条 user 消息

    const other = await boot({ initial: { runs: [run({ runId: 'rB', sessionId: 'B', state: 'starting' })] }, active: 'A' });
    expect(other.pendingStarts.B?.runId).toBe('rB');
    reconnectResume({ cause: 'probe', runs: [], skipOpen: true });
    await drain();
    expect(other.pendingStarts).toEqual({});
    expect(other.runningSessions).toEqual([]);
    expect(notes(other)).toEqual([]);                            // 起跑失败不由本窗口交代
  });

  it('本窗口已经认为在跑的 starting 保留运行标记（attach 落在连 MCP 那一段）', async () => {
    const chat = await boot({ active: 'A' });
    chat.runningSessions = ['A']; chat.running = true;
    box.hooks.applySnapshot(snap({ runs: [run({ runId: 'rA', sessionId: 'A', state: 'starting' })] }), { reason: 'no-cursor', cause: 'probe', epochChanged: false });
    expect(chat.runningSessions).toEqual(['A']);
    expect(chat.running).toBe(true);
    expect(chat.pendingStarts).toEqual({});
  });

  it('权限卡的字段映射只有一份：经广播进入与经快照进入，除 deadlineMs 外深相等；同一个 requestId 先广播后快照只有一张', async () => {
    const v = permView();
    const chat = await boot();
    handlers.get('permission.request')!({ requestId: v.requestId, req: v.req, meta: v.meta });
    const viaBroadcast = { ...chat.pendingPerms[0], deadlineMs: 0 };
    box.hooks.applySnapshot(snap({ pendingPermissions: [v] }), { reason: 'no-cursor', cause: 'join', epochChanged: false });
    expect(chat.pendingPerms).toHaveLength(1);
    const viaSnapshot = { ...chat.pendingPerms[0], deadlineMs: 0 };
    expect(viaSnapshot).toEqual(viaBroadcast);
    expect(viaSnapshot).toMatchObject({ note: '改应用配置', preview: { oldText: '旧', newText: '新' }, riskClass: 'high', bridgeTriggers: ['web-fetch'], toolTitle: '写文件', sessionId: 'A', kind: 'file-write', detail: '写 a.txt', timeoutMs: 90_000 });
    // 再广播一次同一张卡（回放）：原位替换，不出第二张
    handlers.get('permission.request')!({ requestId: v.requestId, req: v.req, meta: v.meta });
    expect(chat.pendingPerms).toHaveLength(1);
  });

  it('当前会话在跑：历史 + 尾巴一次装好（running、joinedTail、不打占位）；尾巴超上限（truncated）退回占位', async () => {
    const chat = await boot({ active: 'A' });
    const live = { runId: 'rA', sessionId: 'A', generation: 2, epoch: 1, text: '已经流出的半句', thinking: '想到一半', seq: 9 };
    const s = snap({ runs: [run({ runId: 'rA', generation: 2 })], live: [live], session: { sessionId: 'A', exists: true, messages: [...box.history.A, msg('a3', 'user', '新问题')] },
      artifacts: [{ sessionId: 'A', runId: 'rA', toolUseId: 't1', tool: 'shell', state: 'completed', writePaths: [], offloadPath: 'offload/1.txt' }] });
    box.hooks.applySnapshot(s, { reason: 'no-cursor', cause: 'join', epochChanged: false });
    expect(chat.messages.map(m => m.id)).toEqual(['a1', 'a2', 'a3']);
    expect([chat.running, chat.joinedTail, chat.midRun]).toEqual([true, true, false]);
    expect([chat.streamingText, chat.streamingThinking]).toEqual(['已经流出的半句', '想到一半']);
    expect(chat.offloadedState).toEqual({ count: 1, lastRelativePath: 'offload/1.txt' });
    expect(chat.runOf.A).toEqual({ runId: 'rA', generation: 2, ended: false });

    box.hooks.applySnapshot({ ...s, live: [{ ...live, text: '', thinking: '', truncated: true }] }, { reason: 'no-cursor', cause: 'join', epochChanged: false });
    expect([chat.running, chat.joinedTail, chat.midRun, chat.streamingText]).toEqual([true, false, true, '']);
  });

  it('快照没带当前会话：running 仍按新的运行集合重算；由假变真时打占位并在收尾时重取（带会话的快照）', async () => {
    const chat = await boot({ active: 'A' });
    box.join = joinSnap(chat, { runs: [run({ runId: 'rA' })], live: [{ runId: 'rA', sessionId: 'A', generation: 1, epoch: 1, text: '尾巴', thinking: '', seq: 3 }] });
    box.hooks.applySnapshot(snap({ runs: [run({ runId: 'rA' })] }), { reason: 'no-cursor', cause: 'gap', epochChanged: false });
    expect([chat.running, chat.midRun]).toEqual([true, true]);
    box.hooks.synced({ via: 'snapshot', cause: 'gap', epochChanged: false, revision: 1, missed: false, inDoubt: [] });
    await drain();
    expect(resyncMock).toHaveBeenCalledWith('join');
    expect([chat.midRun, chat.joinedTail, chat.streamingText]).toEqual([false, true, '尾巴']);
  });

  it('当前会话已不存在（exists:false）：落到欢迎页；它从会话列表里消失后记进 goneSessions', async () => {
    const chat = await boot({ active: 'A' });
    chat.streamingText = '半截';
    box.hooks.applySnapshot(snap({ sessions: [{ id: 'B', title: 'B' }], session: { sessionId: 'A', exists: false, messages: [] } }), { reason: 'no-cursor', cause: 'reconnect', epochChanged: false });
    expect([chat.activeId, chat.messages, chat.streamingText, chat.running]).toEqual(['', [], '', false]);
    expect(chat.goneSessions).toEqual(['A']);
  });

  it('代次变了：清掉 runOf、待批卡整体替换，原来有会话在跑时留一条重建说明；正跟踪的 run 是 interrupted 时另说明没有续跑', async () => {
    const chat = await boot({ initial: { runs: [run({ runId: 'rA' })], pendingPermissions: [permView()] }, active: 'A' });
    expect(chat.runOf.A?.ended).toBe(false);
    const s = snap({ epoch: 2, runs: [run({ runId: 'rA', state: 'interrupted', stopReason: 'engine-crash' })], session: { sessionId: 'A', exists: true, messages: box.history.A } });
    box.hooks.applySnapshot(s, { reason: 'epoch-changed', cause: 'reconnect', epochChanged: true });
    expect([chat.engineEpoch, chat.runningSessions, chat.pendingPerms, chat.running]).toEqual([2, [], [], false]);
    expect(chat.runOf).toEqual({});
    expect(notes(chat)).toEqual(['后台服务已重启，上一次运行被中断，没有自动续跑；没有保存的输出已丢失', '后台服务已重新启动，界面已按最新状态重建']);
  });
});

describe('F06 O 组 · 收口只认本窗口正跟踪的那一次 run', () => {
  it('正跟踪的 run 在快照里已是 failed：恰一条错误条、运行标记撤掉；同一份快照再装一次不出第二条', async () => {
    const chat = await boot({ initial: { runs: [run({ runId: 'rA' })] }, active: 'A' });
    expect(chat.running).toBe(true);
    const s = snap({ runs: [run({ runId: 'rA', state: 'failed', stopReason: 'error', stopDetail: '模型端点 500' })], session: { sessionId: 'A', exists: true, messages: box.history.A } });
    box.hooks.applySnapshot(s, { reason: 'no-cursor', cause: 'reconnect', epochChanged: false });
    expect([chat.running, chat.runningSessions]).toEqual([false, []]);
    expect(chat.eventNotes.map(n => [n.kind, n.detail, n.retryable])).toEqual([['error', '模型端点 500', false]]);
    box.hooks.applySnapshot(s, { reason: 'no-cursor', cause: 'join', epochChanged: false });
    expect(chat.eventNotes).toHaveLength(1);
  });

  // 变异检查补的：收口按 runId 认，不是「该会话在应答里的那一次 run」。把 runs.find(r => r.runId === t.runId)
  // 换成按会话找，原有用例全绿——没有一条用例让「正跟踪的那一次」与「该会话最近一次」是两次不同的 run
  it('正跟踪的 run 已不在应答里，而该会话最近一次 run 是别处起的另一次、已 failed：不替那一次交代（没有错误条、不写 lastError），只撤运行标记；走快照、走续传各一遍', async () => {
    for (const via of ['snapshot', 'resume'] as const) {
      const chat = await boot({ initial: { runs: [run({ runId: 'rA', generation: 1 })] }, active: 'A' });
      expect([chat.running, chat.runOf.A], via).toEqual([true, { runId: 'rA', generation: 1, ended: false }]);
      // 断线期间 rA 结束了（应答只列活动 run 与所带会话的最近一次 run，不再有它）；别处又在这个会话起了 r-other 并以失败收场
      const other = run({ runId: 'r-other', generation: 2, state: 'failed', stopReason: 'error', stopDetail: '别处那一次的错误', userMessageId: 'a3' });
      if (via === 'snapshot') {
        box.hooks.applySnapshot(snap({ runs: [other], session: { sessionId: 'A', exists: true, messages: box.history.A } }), { reason: 'window-expired', cause: 'reconnect', epochChanged: false });
      } else {
        box.join = joinSnap(chat, { runs: [other] });
        reconnectResume({ runs: [other] });
        await drain();
      }
      expect([chat.running, chat.runningSessions], via).toEqual([false, []]);
      expect(notes(chat), via).toEqual([]);                      // 本窗口没跟踪过 r-other：它的失败不由这里交代
      expect(chat.lastError, via).toBe('');
      expect(chat.runOf.A, via).toEqual({ runId: 'r-other', generation: 2, ended: true });
      // 同一份应答再来一次（探测、join）也不补说
      box.hooks.applySnapshot(snap({ runs: [other], session: { sessionId: 'A', exists: true, messages: box.history.A } }), { reason: 'no-cursor', cause: 'join', epochChanged: false });
      expect(notes(chat), via).toEqual([]);
    }
  });

  it('在途的提交不被快照 / 续传校正摘掉：应答里没有这次 run 时 running、运行集合、乐观气泡都不变；prompt 成功后 runOf 记下应答里的 run', async () => {
    const chat = await boot({ active: 'A' });
    let answer!: (v: any) => void;
    box.prompt = () => new Promise(r => { answer = r; });
    const sending = chat.send('新问题');
    await drain();
    const bubble = chat.messages[chat.messages.length - 1];
    expect(bubble.id.startsWith('local-')).toBe(true);
    // attach 先于 chat.prompt 到达引擎：应答里没有这次 run，该会话最近一次 run 是更早的、已 failed 的一次
    const older = run({ runId: 'r-old', generation: 1, state: 'failed', stopDetail: '旧错误' });
    box.hooks.applySnapshot(snap({ runs: [older], session: { sessionId: 'A', exists: true, messages: box.history.A } }), { reason: 'no-cursor', cause: 'probe', epochChanged: false });
    reconnectResume({ cause: 'gap', runs: [older], skipOpen: true });
    await drain();
    expect([chat.running, chat.runningSessions]).toEqual([true, ['A']]);
    expect(chat.messages[chat.messages.length - 1]).toEqual(bubble);
    expect(notes(chat)).toEqual([]);                             // 不拿更早的那次 run 来交代
    answer({ ok: true, runId: 'r-new', generation: 2, duplicate: false, state: 'running' });
    await sending;
    expect(chat.runOf.A).toEqual({ runId: 'r-new', generation: 2, ended: false });
  });

  it('prompt 被引擎拒绝：走原来的 catch，运行标记与乐观气泡撤掉', async () => {
    const chat = await boot({ active: 'A' });
    box.prompt = async () => { throw new Error('该会话正在运行中'); };
    await chat.send('新问题');
    expect([chat.running, chat.runningSessions, chat.lastError]).toEqual([false, [], '该会话正在运行中']);
    expect(chat.messages.map(m => m.id)).toEqual(['a1', 'a2']);
    expect(chat.inDoubtPrompts).toEqual([]);
  });

  it('send() 的应答是 duplicate 且那次 run 已结束：摘掉乐观气泡、撤运行标记（不撤就没有事件来收它）', async () => {
    const chat = await boot({ active: 'A' });
    box.prompt = async () => ({ ok: true, runId: 'r-done', generation: 4, duplicate: true, state: 'completed' });
    await chat.send('早就送达过的那条');
    await drain();
    expect([chat.running, chat.runningSessions]).toEqual([false, []]);
    expect(chat.messages.map(m => m.id)).toEqual(['a1', 'a2']);
    expect(chat.runOf.A).toEqual({ runId: 'r-done', generation: 4, ended: true });
  });
});

describe('F06 O 组 · 晚到的事件不复活旧状态', () => {
  it('当前会话的 run 已收到 error：同一 generation 的晚到增量不起作用；更早 generation、别的代次的事件同样丢弃；没有 run 字段的事件照旧应用', async () => {
    const chat = await boot({ active: 'A' });
    emit('A', { kind: 'textDelta', text: '前半' }, { id: 'r2', generation: 2 });
    expect([chat.running, chat.runningSessions, chat.streamingText]).toEqual([true, ['A'], '前半']);
    emit('A', { kind: 'error', message: '已取消' }, { id: 'r2', generation: 2 });
    await drain();
    const after = [chat.running, [...chat.runningSessions], chat.streamingText];
    emit('A', { kind: 'textDelta', text: '晚到的' }, { id: 'r2', generation: 2 });   // 取消后晚到的增量
    emit('A', { kind: 'textDelta', text: '更早的' }, { id: 'r1', generation: 1 });   // 旧 run
    emit('A', { kind: 'textDelta', text: '旧代次' }, { id: 'r9', generation: 9, epoch: 7 });
    expect([chat.running, [...chat.runningSessions], chat.streamingText]).toEqual(after);
    expect(chat.running).toBe(false);
    // 新的一次 run（generation 更大）照常应用
    emit('A', { kind: 'textDelta', text: '新的' }, { id: 'r3', generation: 3 });
    expect(chat.runningSessions).toEqual(['A']);
    // 没有 run 字段（旧引擎、既有用例的事件形态）：照旧
    handlers.get('chat.event')!({ sessionId: 'B', event: { kind: 'textDelta', text: 'x' } });
    expect(chat.runningSessions).toEqual(['A', 'B']);
  });

  it('会话从列表里消失之后，它的 run 事件（含更大的 generation）不再把运行条点回来；待批卡一并摘掉', async () => {
    const chat = await boot({ active: 'A' });
    emit('B', { kind: 'textDelta', text: 'x' }, { id: 'rb', generation: 1 });
    handlers.get('permission.request')!({ requestId: 'RB', req: { sessionId: 'B', kind: 'shell', detail: 'd', toolTitle: 't' }, meta: { timeoutMs: 1000 } });
    expect(chat.runningSessions).toEqual(['B']);
    box.sessions = [{ id: 'A', title: 'A' }];
    handlers.get('chat.sessions.changed')!({});
    await drain();
    expect([chat.goneSessions, chat.runningSessions, chat.pendingPerms]).toEqual([['B'], [], []]);
    emit('B', { kind: 'textDelta', text: '晚到' }, { id: 'rb', generation: 1 });
    emit('B', { kind: 'textDelta', text: '更晚' }, { id: 'rb2', generation: 5 });
    expect(chat.runningSessions).toEqual([]);
    // 对端同步把同一个 id 带回来：不再算消失
    box.sessions = [{ id: 'A', title: 'A' }, { id: 'B', title: 'B' }];
    await chat.refreshSessions();
    expect(chat.goneSessions).toEqual([]);
  });
});

describe('F06 O 组 · 重连期间与重连之后', () => {
  it('reconnecting：运行态、卡片、正文都不动；send / open / respondPerm / cancel 都不发调用；status(open) 之后恢复可用', async () => {
    const chat = await boot({ initial: { runs: [run({ runId: 'rA' })], pendingPermissions: [permView()] }, active: 'A' });
    chat.streamingText = '流到一半'; chat.toolCards = [{ toolUseId: 't', name: 'shell', title: '跑命令' }];
    goReconnecting();
    expect(chat.connection).toBe('reconnecting');
    expect(chat.link).toEqual({ attempt: 1, maxAttempts: 8, retryInMs: 500 });
    expect([chat.running, chat.runningSessions, chat.pendingPerms.length, chat.streamingText, chat.toolCards.length]).toEqual([true, ['A'], 1, '流到一半', 1]);
    await chat.send('这时发的');
    await chat.open('B');
    await chat.respondPerm('R1', 'allow-once');
    await chat.cancel();
    expect(methods()).toEqual([]);
    expect([chat.activeId, chat.pendingPerms.length, chat.lastError]).toEqual(['A', 1, '连接恢复后才能停止']);
    expect(chat.messages.map(m => m.id)).toEqual(['a1', 'a2']);    // 没有推乐观气泡

    box.hooks.status({ state: 'open', attempt: 0, maxAttempts: 8 });
    expect([chat.connection, chat.link]).toEqual(['ok', null]);
    await chat.respondPerm('R1', 'allow-once');
    expect(callsOf('permission.respond')).toEqual([{ requestId: 'R1', decision: 'allow-once' }]);
  });

  it('终态 lost：走原来的 markConnectionLost；引擎没退出时给「重新连接」，退出了不给；retryConnection 调 rpc.retryNow', async () => {
    const chat = await boot({ initial: { runs: [run({ runId: 'rA' })], pendingPermissions: [permView()] }, active: 'A' });
    goReconnecting();
    box.hooks.status({ state: 'lost', attempt: 0, maxAttempts: 8, reason: 'exhausted' });
    box.onLost!();
    expect([chat.connection, chat.linkRetryable, chat.running, chat.runningSessions, chat.pendingPerms, chat.link]).toEqual(['lost', true, false, [], [], null]);
    chat.retryConnection();
    expect(retryNowMock).toHaveBeenCalledTimes(1);
    box.hooks.status({ state: 'lost', attempt: 0, maxAttempts: 8, reason: 'engine-exited' });
    expect(chat.linkRetryable).toBe(false);
  });

  it('重连走续传、回放里什么都没有：仍然重取当前会话，并整体刷新没有广播的域；linkGeneration 加一', async () => {
    const chat = await boot({ active: 'A' });
    box.history.A = [...box.history.A, msg('a3', 'assistant', '断线期间写完的回答')];
    box.join = joinSnap(chat);
    goReconnecting();
    reconnectResume();
    await drain();
    expect(resyncMock).toHaveBeenCalledWith('join');
    expect(chat.messages.map(m => m.id)).toEqual(['a1', 'a2', 'a3']);
    for (const m of ['provider.instances.list', 'modelgroup.list', 'assistants.list', 'cron.list', 'control.status', 'permission.getPreset', 'chat.annotations.list', 'workspace.get']) expect(methods(), m).toContain(m);
    expect(chat.linkGeneration).toBe(1);
    expect(chat.connection).toBe('ok');
  });

  it('取不到带会话的快照时退回 open()：同样把历史换成最新的', async () => {
    const chat = await boot({ active: 'A' });
    box.history.A = [...box.history.A, msg('a3', 'assistant', '断线期间写完的回答')];
    goReconnecting();
    reconnectResume();
    await drain();
    expect(callsOf('chat.messages.list')).toEqual([{ sessionId: 'A' }]);
    expect(chat.messages.map(m => m.id)).toEqual(['a1', 'a2', 'a3']);
  });

  it('回放含 turnEnd：处理器自己的重取发得出去（connection 已是 ok），同步完成后历史是新的、不在跑、缓冲为空', async () => {
    const chat = await boot({ initial: { runs: [run({ runId: 'rA' })] }, active: 'A' });
    chat.streamingText = '流到一半';
    box.history.A = [...box.history.A, msg('a3', 'assistant', '完整的回答')];
    box.join = joinSnap(chat, { runs: [run({ runId: 'rA', state: 'completed', stopReason: 'end_turn' })] });
    goReconnecting();
    reconnectResume({ events: [{ method: 'chat.event', params: evt('A', { kind: 'turnEnd', stopReason: 'end_turn' }, { id: 'rA' }) }], runs: [] });
    await drain();
    expect(callsOf('chat.messages.list').length).toBeGreaterThanOrEqual(1);   // 回放的 turnEnd 调的 open() 没有被 reconnecting 挡回去
    expect([chat.running, chat.runningSessions, chat.streamingText, chat.toolCards]).toEqual([false, [], '', []]);
    expect(chat.messages.map(m => m.id)).toEqual(['a1', 'a2', 'a3']);
    expect(notes(chat)).toEqual([]);                             // 终止事件已经处理过，校正不再交代第二遍
  });

  it('不是重连的续传（gap）不整体刷新；join 的水位之前有帧没到齐（missed）才刷新；续传后 revision 变了重拉会话列表', async () => {
    const chat = await boot({ active: 'A' });
    reconnectResume({ cause: 'gap', skipOpen: true });
    await drain();
    expect(methods()).toEqual([]);
    expect(chat.linkGeneration).toBe(0);
    reconnectResume({ cause: 'gap', skipOpen: true, revision: 7 });
    await drain();
    expect(methods()).toEqual(['chat.sessions.list']);
    expect(chat.streamRevision).toBe(7);
    rpcCallMock.mockClear();
    box.hooks.synced({ via: 'snapshot', cause: 'join', epochChanged: false, revision: 7, missed: true, inDoubt: [] });
    await drain();
    expect(methods()).toContain('assistants.list');
    expect(methods()).toContain('cron.list');
  });

  it('换会话的 open() 在途时断线：重连后当前会话的历史换成新会话的，旧会话的半截缓冲清掉', async () => {
    const chat = await boot({ active: 'A' });
    chat.streamingText = 'A 的半截'; chat.toolCards = [{ toolUseId: 't', name: 'shell', title: '跑命令' }];
    box.lists = { 'chat.messages.list': async () => { throw inFlight(); } };
    await chat.open('B').catch(() => undefined);
    expect([chat.activeId, chat.messages.map(m => m.id), chat.streamingText]).toEqual(['B', ['a1', 'a2'], 'A 的半截']); // 标题已换、对话流还是 A 的
    box.lists = undefined;
    box.join = joinSnap(chat);
    goReconnecting();
    reconnectResume();
    await drain();
    expect([chat.activeId, chat.messages.map(m => m.id), chat.streamingText, chat.toolCards]).toEqual(['B', ['b1'], '', []]);
  });

  it('断线时在途的其它写调用：留一条「结果未知」并说明数量；只读调用不算', async () => {
    const chat = await boot({ active: 'A' });
    box.join = joinSnap(chat);
    goReconnecting();
    reconnectResume({ inDoubt: [{ method: 'chat.sessions.rename', params: {} }, { method: 'assistants.create', params: {} }, { method: 'chat.sessions.list', params: undefined }, { method: 'chat.prompt', params: {} }] });
    await drain();
    expect(notes(chat)).toEqual(['连接中断时有 2 个操作的结果未知，界面已按当前状态刷新，请核对后再决定是否重做']);
    expect(isWriteMethod('chat.sessions.rename')).toBe(true);
    expect(isWriteMethod('没见过的新方法')).toBe(true);
    expect(isWriteMethod('chat.messages.list')).toBe(false);
    expect(isWriteMethod('state.attach')).toBe(false);
  });

  it('续传校正：应答里没有的卡摘掉、缺的补上、倒计时按剩余时间重算', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(5_000_000);
    const chat = await boot({ initial: { pendingPermissions: [permView({ requestId: 'R-old' }), permView({ requestId: 'R-keep' })] } });
    chat.pendingPerms[1].deadlineMs = 1;
    reconnectResume({ cause: 'gap', skipOpen: true, perms: [permView({ requestId: 'R-keep', remainingMs: 12_000 }), permView({ requestId: 'R-new', remainingMs: 80_000 })] });
    expect(chat.pendingPerms.map(p => [p.requestId, p.deadlineMs])).toEqual([['R-keep', 5_012_000], ['R-new', 5_080_000]]);
  });
});

describe('F06 O 组 · 在途的发送：只查询、不重发', () => {
  async function sendThenCut(chat: any, text = '断线时发的') {
    box.prompt = async () => { throw inFlight(); };
    await chat.send(text, ['att/a.png']);
    box.prompt = undefined;
    return chat.messages[chat.messages.length - 1];
  }

  it('应答随断线丢了：不撤气泡、不动运行态、不写错误、不重发；记入 inDoubtPrompts', async () => {
    const chat = await boot({ active: 'A' });
    const bubble = await sendThenCut(chat);
    const sent = callsOf('chat.prompt');
    expect(sent).toHaveLength(1);
    expect(chat.inDoubtPrompts).toEqual([{ sessionId: 'A', promptId: sent[0].promptId, text: '断线时发的', attachments: ['att/a.png'], optimisticId: bubble.id }]);
    expect([chat.running, chat.runningSessions, chat.lastError]).toEqual([true, ['A'], '']);
    expect(chat.messages[chat.messages.length - 1].id).toBe(bubble.id);
  });

  it('核对出「已接收」：不做任何发送；乐观气泡换成真实消息；仍在跑则运行条在、没有错误条', async () => {
    const chat = await boot({ active: 'A' });
    const bubble = await sendThenCut(chat);
    const promptId = callsOf('chat.prompt')[0].promptId;
    const accepted = run({ runId: 'r-acc', generation: 2, state: 'running', promptId, userMessageId: 'a3' });
    box.history.A = [...box.history.A, msg('a3', 'user', '断线时发的')];
    box.outcomes = refs => refs.map((r: any) => ({ ...r, status: 'accepted', run: accepted }));
    box.join = joinSnap(chat, { runs: [accepted] });
    goReconnecting();
    reconnectResume({ runs: [accepted], inDoubt: [{ method: 'chat.prompt', params: {} }] });
    await drain();
    expect(callsOf('state.outcomes')).toEqual([{ refs: [{ kind: 'prompt', sessionId: 'A', promptId }] }]);
    expect(callsOf('chat.prompt')).toHaveLength(1);              // 只有断线前那一次
    expect(chat.messages.map(m => m.id)).toEqual(['a1', 'a2', 'a3']);
    expect(chat.messages.some(m => m.id === bubble.id)).toBe(false);
    expect([chat.running, chat.runningSessions, chat.inDoubtPrompts, notes(chat)]).toEqual([true, ['A'], [], []]);
    expect(chat.runOf.A).toEqual({ runId: 'r-acc', generation: 2, ended: false });
  });

  it('核对出「没有送达」，而该会话上一次 run 是 failed：事件条只有「没有送达」一条（带重试），气泡留着，不重取历史，不自动重发；点重试沿用同一个 promptId', async () => {
    for (const via of ['resume', 'snapshot'] as const) {
      for (const olderState of ['failed', 'interrupted']) {
        const chat = await boot({ active: 'A' });
        const bubble = await sendThenCut(chat);
        const promptId = callsOf('chat.prompt')[0].promptId;
        const older = run({ runId: 'r-old', generation: 1, state: olderState, stopDetail: '上一次的错误' });
        box.outcomes = refs => refs.map((r: any) => ({ ...r, status: 'not-accepted' }));
        box.join = joinSnap(chat, { runs: [older] });
        goReconnecting();
        rpcCallMock.mockClear();
        if (via === 'resume') reconnectResume({ runs: [older], inDoubt: [{ method: 'chat.prompt', params: {} }] });
        else {
          box.hooks.status({ state: 'open', attempt: 0, maxAttempts: 8 });
          box.hooks.applySnapshot(joinSnap(chat, { runs: [older] })(), { reason: 'window-expired', cause: 'reconnect', epochChanged: false });
          box.hooks.synced({ via: 'snapshot', cause: 'reconnect', epochChanged: false, revision: 1, missed: false, inDoubt: [{ method: 'chat.prompt', params: {} }] });
        }
        await drain();
        const label = `${via}/${olderState}`;
        expect(notes(chat), label).toEqual(['连接中断时这条消息没有送达，没有自动重发。点重试重新发送。']);
        expect(chat.eventNotes[0].retryable, label).toBe(true);
        expect(chat.messages[chat.messages.length - 1].id, label).toBe(bubble.id);
        expect([chat.running, chat.runningSessions], label).toEqual([false, []]);
        expect(callsOf('chat.prompt'), label).toEqual([]);       // 没有自动重发
        expect(chat.undelivered?.promptId, label).toBe(promptId);
        // 核对出结论之后没有再取历史（气泡不被抹掉）
        const iOut = methods().indexOf('state.outcomes');
        expect(methods().slice(iOut + 1).filter(m => m === 'chat.messages.list'), label).toEqual([]);

        await chat.retryLast();
        const again = callsOf('chat.prompt');
        expect(again, label).toHaveLength(1);
        expect(again[0], label).toEqual({ sessionId: 'A', text: '断线时发的', attachments: ['att/a.png'], promptId });
        expect(chat.messages.filter(m => m.role === 'user' && m.id.startsWith('local-')), label).toHaveLength(1);
        expect(chat.undelivered, label).toBeNull();
      }
    }
  });

  it('核对的查询本身失败（又断了）：条目留着，下一次同步后再核对；进入终态时如实说「是否送达未知」并清表', async () => {
    const chat = await boot({ active: 'A' });
    await sendThenCut(chat);
    box.join = joinSnap(chat);
    box.lists = { 'state.outcomes': async () => { throw new Error(LOST); } };
    goReconnecting();
    reconnectResume({ inDoubt: [{ method: 'chat.prompt', params: {} }] });
    await drain();
    expect(chat.inDoubtPrompts).toHaveLength(1);
    expect([chat.running, chat.runningSessions]).toEqual([true, ['A']]);
    expect(notes(chat)).toEqual([]);
    goReconnecting();
    box.hooks.status({ state: 'lost', attempt: 0, maxAttempts: 8, reason: 'exhausted' });
    box.onLost!();
    expect(notes(chat)).toEqual(['连接中断时有一条消息是否送达未知，请查看对话后再决定是否重发']);
    expect(chat.inDoubtPrompts).toEqual([]);
    expect(callsOf('chat.prompt')).toHaveLength(1);
  });
});

describe('F06 O 组 · 在途的权限答复：只查询、不重发', () => {
  async function respondThenCut(chat: any) {
    box.respond = async () => { throw inFlight(); };
    await chat.respondPerm('R1', 'allow-once');
    box.respond = undefined;
    expect(chat.inDoubtPerms).toEqual([{ requestId: 'R1', sessionId: 'A' }]);
    expect(callsOf('permission.respond')).toHaveLength(1);
  }

  it('卡重新出现（答复没有送达）：留条请重新选择，不查询也不重发；用户再点才发第二次', async () => {
    const chat = await boot({ initial: { runs: [run({ runId: 'rA' })], pendingPermissions: [permView()] }, active: 'A' });
    await respondThenCut(chat);
    box.join = joinSnap(chat, { runs: [run({ runId: 'rA' })], pendingPermissions: [permView()] });
    goReconnecting();
    reconnectResume({ runs: [run({ runId: 'rA' })], perms: [permView()], inDoubt: [{ method: 'permission.respond', params: {} }] });
    await drain();
    expect(chat.pendingPerms.map(p => p.requestId)).toEqual(['R1']);
    expect(notes(chat)).toEqual(['连接中断时你的选择没有送达，请重新选择']);
    expect(callsOf('state.outcomes')).toEqual([]);
    expect(callsOf('permission.respond')).toHaveLength(1);
    expect(chat.inDoubtPerms).toEqual([]);
    await chat.respondPerm('R1', 'allow-once');
    expect(callsOf('permission.respond')).toHaveLength(2);
  });

  it('卡不在了：查 state.outcomes，按真实结局留条（已按「允许」处理）；unknown 如实说未知；都不重发', async () => {
    const chat = await boot({ initial: { runs: [run({ runId: 'rA' })], pendingPermissions: [permView()] }, active: 'A' });
    await respondThenCut(chat);
    box.join = joinSnap(chat, { runs: [run({ runId: 'rA' })] });
    box.outcomes = refs => refs.map((r: any) => ({ ...r, status: 'settled', source: 'broker', settled: { reason: 'answered', decision: 'allow' } }));
    goReconnecting();
    reconnectResume({ runs: [run({ runId: 'rA' })], perms: [], inDoubt: [{ method: 'permission.respond', params: {} }] });
    await drain();
    expect(callsOf('state.outcomes')).toEqual([{ refs: [{ kind: 'permission', requestId: 'R1' }] }]);
    expect(notes(chat)).toEqual(['这张权限卡已按「允许」处理。对应操作是否执行以对话里的工具结果为准']);
    expect(callsOf('permission.respond')).toHaveLength(1);
    expect(chat.inDoubtPerms).toEqual([]);

    const other = await boot({ initial: { runs: [run({ runId: 'rA' })], pendingPermissions: [permView()] }, active: 'A' });
    await respondThenCut(other);
    box.outcomes = refs => refs.map((r: any) => ({ ...r, status: 'unknown' }));
    goReconnecting();
    reconnectResume({ runs: [run({ runId: 'rA' })], perms: [], inDoubt: [] });
    await drain();
    expect(notes(other)).toEqual(['这次权限答复的结果未知；对应操作是否执行以对话里的工具结果为准']);
  });

  it('permOutcomeNote：七种结局各说各的，超时 / 取消 / 失效 / 过期不说成用户拒绝', () => {
    const tail = '。对应操作是否执行以对话里的工具结果为准';
    const b = (reason: string, decision = 'deny') => permOutcomeNote({ source: 'broker', settled: { reason, decision } });
    const l = (state: string, reason?: string, cause?: string) => permOutcomeNote({ source: 'ledger', approval: { state, reason, cause } });
    const allow = '这张权限卡已按「允许」处理' + tail;
    const deny = '这张权限卡已按「拒绝」处理' + tail;
    const timeout = '这张权限卡已超时，没有放行' + tail;
    const cancelled = '这张权限卡已随运行取消（停止、删除会话或后台服务关停），没有执行' + tail;
    const invalidated = '这张权限卡已失效（相关服务被停用或配置已修改），没有执行' + tail;
    const expired = '这张权限卡已随后台服务重启失效，没有批准，也没有执行' + tail;
    const other = '这张权限卡没有放行' + tail;
    expect([b('answered', 'allow'), l('allowed')]).toEqual([allow, allow]);
    expect([b('answered', 'deny'), l('denied', 'user-denied')]).toEqual([deny, deny]);
    expect([b('timeout'), l('denied', 'timeout')]).toEqual([timeout, timeout]);
    expect([b('cancelled'), b('session-deleted'), b('shutdown'), l('denied', 'cancelled', 'shutdown')]).toEqual([cancelled, cancelled, cancelled, cancelled]);
    expect([b('invalidated'), l('denied', 'invalidated')]).toEqual([invalidated, invalidated]);
    expect(l('expired', 'invalidated', 'engine-restarted')).toBe(expired);
    expect([l('denied'), l('denied', '没见过的原因'), b('没见过的原因')]).toEqual([other, other, other]);
    expect(new Set([allow, deny, timeout, cancelled, invalidated, expired, other]).size).toBe(7);
  });
});

describe('F06 O 组 · 尾巴模式（经快照接上的回合）', () => {
  async function joined() {
    const chat = await boot({ active: 'A' });
    const live = { runId: 'rA', sessionId: 'A', generation: 1, epoch: 1, text: '第一段', thinking: '', seq: 5 };
    box.hooks.applySnapshot(snap({ runs: [run({ runId: 'rA' })], live: [live], session: { sessionId: 'A', exists: true, messages: box.history.A } }), { reason: 'no-cursor', cause: 'join', epochChanged: false });
    expect(chat.joinedTail).toBe(true);
    rpcCallMock.mockClear();
    return chat;
  }
  const flow = (chat: any): string => chat.messages.filter((m: any) => m.role === 'assistant').map((m: any) => m.parts.map((p: any) => p.value).join('')).join('') + chat.streamingText;

  it('toolStart 不建步骤卡（历史里的 toolUse 已经画着「结果还没到」）', async () => {
    const chat = await joined();
    emit('A', { kind: 'toolStart', toolUseId: 't1', name: 'shell', title: '跑命令' }, { id: 'rA' });
    expect(chat.toolCards).toEqual([]);
  });

  it('messagePersisted：重取应答到达之前是「旧历史 + 完整缓冲」，之后是「新历史 + 切剩的缓冲」，拼出来的全文相同、每段只出现一次', async () => {
    const chat = await joined();
    emit('A', { kind: 'textDelta', text: '第二段' }, { id: 'rA' });
    let answer!: (v: any[]) => void;
    box.lists = { 'chat.messages.list': () => new Promise<any[]>(r => { answer = r; }) };
    emit('A', { kind: 'messagePersisted', messageId: 'a3' }, { id: 'rA' });
    emit('A', { kind: 'textDelta', text: '第三段' }, { id: 'rA' });       // 应答之前又流出一段（下一条消息的开头）
    await drain();
    const before = flow(chat);
    expect(before).toBe('上一条的回答第一段第二段第三段');
    answer([...box.history.A, msg('a3', 'assistant', '第一段第二段')]);
    await drain();
    expect(chat.messages.map(m => m.id)).toEqual(['a1', 'a2', 'a3']);
    expect(chat.streamingText).toBe('第三段');
    expect(flow(chat)).toBe(before);
  });

  it('两条 messagePersisted 连到：只采用最新一次重取；retry 把切点归零（缓冲已清，不能再按旧长度切）', async () => {
    const chat = await joined();
    const answers: ((v: any[]) => void)[] = [];
    box.lists = { 'chat.messages.list': () => new Promise<any[]>(r => { answers.push(r); }) };
    emit('A', { kind: 'messagePersisted', messageId: 'a3' }, { id: 'rA' });
    emit('A', { kind: 'textDelta', text: '第二段' }, { id: 'rA' });
    emit('A', { kind: 'messagePersisted', messageId: 'a4' }, { id: 'rA' });
    await drain();
    expect(answers).toHaveLength(2);
    answers[0]([...box.history.A, msg('a3', 'assistant', '第一段')]);                              // 旧的一次先到：丢弃
    await drain();
    expect([chat.messages.map(m => m.id), chat.streamingText]).toEqual([['a1', 'a2'], '第一段第二段']);
    answers[1]([...box.history.A, msg('a3', 'assistant', '第一段'), msg('a4', 'assistant', '第二段')]);
    await drain();
    expect([chat.messages.map(m => m.id), chat.streamingText]).toEqual([['a1', 'a2', 'a3', 'a4'], '']);

    // retry：在途的重取回来之后不能把重试后新流出的正文切掉
    emit('A', { kind: 'textDelta', text: '要被重试丢掉的' }, { id: 'rA' });
    emit('A', { kind: 'messagePersisted', messageId: 'a5' }, { id: 'rA' });
    emit('A', { kind: 'retry', attempt: 1, delayMs: 0 }, { id: 'rA' });
    emit('A', { kind: 'textDelta', text: '重试后的正文' }, { id: 'rA' });
    await drain();
    answers[2]([...box.history.A]);
    await drain();
    expect(chat.streamingText).toBe('重试后的正文');
  });

  it('turnEnd 结束尾巴模式；send() 发起的回合不走尾巴模式', async () => {
    const chat = await joined();
    emit('A', { kind: 'turnEnd', stopReason: 'end_turn' }, { id: 'rA' });
    await drain();
    expect([chat.joinedTail, chat.running]).toEqual([false, false]);
    const again = await joined();
    emit('A', { kind: 'turnEnd', stopReason: 'end_turn' }, { id: 'rA' });
    await drain();
    again.joinedTail = true;
    await again.send('下一条');
    expect(again.joinedTail).toBe(false);
  });
});

/** 发送的应答随断线丢了（停在发它的那个会话上）。返回当时的乐观气泡与这次提交的 promptId。 */
async function cutSend(chat: any, text = '断线时发的') {
  box.prompt = async () => { throw inFlight(); };
  await chat.send(text, ['att/a.png']);
  box.prompt = undefined;
  const bubble = chat.messages[chat.messages.length - 1];
  return { bubble: { id: bubble.id, role: bubble.role, parts: JSON.parse(JSON.stringify(bubble.parts)) }, promptId: callsOf('chat.prompt').at(-1).promptId as string };
}
/** 发送还挂着（比如引擎在连 MCP）时用户切到别的会话，随后应答随断线丢了。 */
async function cutSendAfterSwitch(chat: any, to = 'B', text = '断线时发的') {
  let reject!: (e: unknown) => void;
  box.prompt = () => new Promise((_, rej) => { reject = rej; });
  const sending = chat.send(text, ['att/a.png']);
  await drain();
  const b = chat.messages[chat.messages.length - 1];
  const bubble = { id: b.id, role: b.role, parts: JSON.parse(JSON.stringify(b.parts)) };
  await chat.open(to);
  reject(inFlight());
  await sending;
  box.prompt = undefined;
  return { bubble, promptId: callsOf('chat.prompt').at(-1).promptId as string };
}
/** mediaRef 的 id 是随机的，比较气泡形态时抹掉。 */
const shapeOf = (parts: any[]): any[] => parts.map(p => (p.type === 'mediaRef' ? { type: p.type, value: { ...p.value, id: '' } } : p));
const UNDELIVERED = '连接中断时这条消息没有送达，没有自动重发。点重试重新发送。';

describe('F06 O 组 · 在途的发送核对出「已接收且已结束」：运行标记收得掉、结局只交代一次', () => {
  const fin = (promptId: string, o: Record<string, unknown> = {}) =>
    run({ runId: 'r-acc', generation: 2, state: 'completed', stopReason: 'endTurn', promptId, userMessageId: 'a3', ...o });
  /** 断线期间那次 run 的事件（续传时回放）：正文、终止事件。 */
  const replayOf = (end: Record<string, unknown> = { kind: 'turnEnd', stopReason: 'endTurn' }) => [
    { method: 'chat.event', params: evt('A', { kind: 'textDelta', text: '断线期间的回答' }, { id: 'r-acc', generation: 2 }) },
    { method: 'chat.event', params: evt('A', end, { id: 'r-acc', generation: 2 }) },
  ];
  const landed = (): void => { box.history.A = [...box.history.A, msg('a3', 'user', '断线时发的'), msg('a4', 'assistant', '断线期间的回答')]; };
  const IN_DOUBT = [{ method: 'chat.prompt', params: {} }];
  /** 重连走快照：开闸、装快照（带当前会话）、收尾。 */
  const reconnectSnapshot = (chat: any, runs: any[]): void => {
    box.hooks.status({ state: 'open', attempt: 0, maxAttempts: 8 });
    box.hooks.applySnapshot(joinSnap(chat, { runs })(), { reason: 'window-expired', cause: 'reconnect', epochChanged: false });
    box.hooks.synced({ via: 'snapshot', cause: 'reconnect', epochChanged: false, revision: 1, missed: false, inDoubt: IN_DOUBT });
  };

  for (const via of ['resume', 'snapshot'] as const) {
    it(`当前会话 / 重连走${via === 'resume' ? '续传（回放含终止事件）' : '快照'}：不在跑、历史是真实消息、不再探测；只查询一次、没有重发`, async () => {
      const chat = await boot({ active: 'A' });
      const { bubble, promptId } = await cutSend(chat);
      landed();
      const done = fin(promptId);
      box.outcomes = refs => refs.map((r: any) => ({ ...r, status: 'accepted', run: done }));
      box.join = joinSnap(chat, { runs: [done] });
      goReconnecting();
      if (via === 'resume') reconnectResume({ events: replayOf(), runs: [done], inDoubt: IN_DOUBT });
      else reconnectSnapshot(chat, [done]);
      await drain();
      expect(callsOf('state.outcomes')).toEqual([{ refs: [{ kind: 'prompt', sessionId: 'A', promptId }] }]);
      expect(callsOf('chat.prompt')).toHaveLength(1);
      expect([chat.inDoubtPrompts, chat.runningSessions, chat.running, chat.midRun, chat.joinedTail]).toEqual([[], [], false, false, false]);
      expect(chat.messages.map(m => m.id)).toEqual(['a1', 'a2', 'a3', 'a4']);
      expect(chat.messages.some(m => m.id === bubble.id)).toBe(false);
      expect(chat.runOf.A).toEqual({ runId: 'r-acc', generation: 2, ended: true });
      expect(box.hooks.wantProbe()).toBe(false);
      expect(notes(chat)).toEqual([]);
    });

    it(`非当前会话 / 重连走${via === 'resume' ? '续传（回放含终止事件）' : '快照'}：那个会话不再标着在跑；切回去不闪「仍在运行」`, async () => {
      const chat = await boot({ active: 'A' });
      const { promptId } = await cutSendAfterSwitch(chat);
      expect([chat.activeId, chat.runningSessions, chat.inDoubtPrompts.map(p => p.sessionId)]).toEqual(['B', ['A'], ['A']]);
      landed();
      const done = fin(promptId);
      box.outcomes = refs => refs.map((r: any) => ({ ...r, status: 'accepted', run: done }));
      box.join = joinSnap(chat);                                // 带的是当前会话 B；应答里只列活动 run，没有甲那一次
      goReconnecting();
      if (via === 'resume') reconnectResume({ events: replayOf(), runs: [], inDoubt: IN_DOUBT });
      else reconnectSnapshot(chat, []);
      await drain();
      expect(callsOf('state.outcomes')).toHaveLength(1);
      expect(callsOf('chat.prompt')).toHaveLength(1);
      expect([chat.activeId, chat.inDoubtPrompts, chat.runningSessions]).toEqual(['B', [], []]);
      expect(chat.runOf.A).toEqual({ runId: 'r-acc', generation: 2, ended: true });
      expect(box.hooks.wantProbe()).toBe(false);
      // 切回甲：open() 开头按运行集合取 running，标记没摘的话这里先亮一下停止键与「仍在运行」的占位
      const opening = chat.open('A');
      expect([chat.running, chat.midRun]).toEqual([false, false]);
      await opening;
      expect(chat.messages.map(m => m.id)).toEqual(['a1', 'a2', 'a3', 'a4']);
      expect(notes(chat)).toEqual([]);
    });
  }

  it('当前会话 / 续传，带会话的快照取不到（退回 open()）：同样收得掉——不留一个亮着的停止键', async () => {
    const chat = await boot({ active: 'A' });
    const { promptId } = await cutSend(chat);
    landed();
    const done = fin(promptId);
    box.outcomes = refs => refs.map((r: any) => ({ ...r, status: 'accepted', run: done }));
    goReconnecting();
    reconnectResume({ events: replayOf(), runs: [done], inDoubt: IN_DOUBT });   // box.join 没给：resync('join') 失败
    await drain();
    expect([chat.inDoubtPrompts, chat.runningSessions, chat.running, chat.midRun]).toEqual([[], [], false, false]);
    expect(chat.messages.map(m => m.id)).toEqual(['a1', 'a2', 'a3', 'a4']);
  });

  it('回放里那个会话之后又跑完了更晚的一次 run：照样摘；更晚的一次还在跑：标记留给它', async () => {
    const later = (end: boolean) => [
      { method: 'chat.event', params: evt('A', { kind: 'textDelta', text: '别处又问了一句' }, { id: 'r-later', generation: 3 }) },
      ...(end ? [{ method: 'chat.event', params: evt('A', { kind: 'turnEnd', stopReason: 'endTurn' }, { id: 'r-later', generation: 3 }) }] : []),
    ];
    const chat = await boot({ active: 'A' });
    const { promptId } = await cutSendAfterSwitch(chat);
    const done = fin(promptId);
    box.outcomes = refs => refs.map((r: any) => ({ ...r, status: 'accepted', run: done }));
    box.join = joinSnap(chat);
    goReconnecting();
    reconnectResume({ events: [...replayOf(), ...later(true)], runs: [], inDoubt: IN_DOUBT });
    await drain();
    expect([chat.inDoubtPrompts, chat.runningSessions]).toEqual([[], []]);
    expect(chat.runOf.A).toEqual({ runId: 'r-later', generation: 3, ended: true });

    const other = await boot({ active: 'A' });
    const second = await cutSendAfterSwitch(other);
    const done2 = fin(second.promptId);
    const running = run({ runId: 'r-later', generation: 3, state: 'running' });
    box.outcomes = refs => refs.map((r: any) => ({ ...r, status: 'accepted', run: done2 }));
    box.join = joinSnap(other, { runs: [running] });
    goReconnecting();
    reconnectResume({ events: [...replayOf(), ...later(false)], runs: [running], inDoubt: IN_DOUBT });
    await drain();
    expect([other.inDoubtPrompts, other.runningSessions]).toEqual([[], ['A']]);
    expect(other.runOf.A).toEqual({ runId: 'r-later', generation: 3, ended: false });
  });

  it('已接收、断线期间以失败结束：走快照时由核对结果交代恰一条错误条（带重试）；走续传时回放的 error 事件已经交代过，不说第二遍', async () => {
    for (const via of ['snapshot', 'resume'] as const) {
      const chat = await boot({ active: 'A' });
      const { promptId } = await cutSend(chat);
      box.history.A = [msg('a1', 'user', '上一条'), msg('a2', 'assistant', '上一条的回答'), msg('a3', 'user', '断线时发的')];
      const failed = fin(promptId, { state: 'failed', stopReason: 'error', stopDetail: '模型端点 500' });
      box.outcomes = refs => refs.map((r: any) => ({ ...r, status: 'accepted', run: failed }));
      box.join = joinSnap(chat, { runs: [failed] });
      goReconnecting();
      if (via === 'resume') reconnectResume({ events: replayOf({ kind: 'error', message: '模型端点 500' }), runs: [failed], inDoubt: IN_DOUBT });
      else reconnectSnapshot(chat, [failed]);
      await drain();
      expect(chat.eventNotes.map(n => [n.kind, n.detail, n.retryable]), via).toEqual([['error', '模型端点 500', true]]);
      expect([chat.inDoubtPrompts, chat.runningSessions, chat.running, chat.lastError], via).toEqual([[], [], false, '模型端点 500']);
      expect(chat.messages.map(m => m.id), via).toEqual(['a1', 'a2', 'a3']);
      expect(callsOf('chat.prompt'), via).toHaveLength(1);
    }
  });
});

describe('F06 O 组 · 别的会话的核对结果：切回去时交代，重试入口还在', () => {
  it('发送在途时切走、核对出「没有送达」：当前会话不串条；切回原会话气泡回到末尾、带重试的说明在；点重试沿用原 promptId', async () => {
    const chat = await boot({ active: 'A' });
    const { bubble, promptId } = await cutSendAfterSwitch(chat);
    box.outcomes = refs => refs.map((r: any) => ({ ...r, status: 'not-accepted' }));
    box.join = joinSnap(chat);
    goReconnecting();
    reconnectResume({ runs: [], inDoubt: [{ method: 'chat.prompt', params: {} }] });
    await drain();
    // 还在乙：不往乙的事件条里写甲的事，也不点亮什么；甲不再标着在跑
    expect([chat.activeId, notes(chat), chat.lastError, chat.runningSessions]).toEqual(['B', [], '', []]);
    expect(chat.messages.map(m => m.id)).toEqual(['b1']);
    expect(chat.undelivered).toMatchObject({ sessionId: 'A', promptId, text: '断线时发的' });
    expect(callsOf('chat.prompt')).toHaveLength(1);              // 没有自动重发

    await chat.open('A');
    expect(chat.messages.map(m => m.id)).toEqual(['a1', 'a2', bubble.id]);
    const back = chat.messages[chat.messages.length - 1];
    expect([back.role, shapeOf(back.parts)]).toEqual([bubble.role, shapeOf(bubble.parts)]);   // 与当初 send() 推的那条同构
    expect(notes(chat)).toEqual([UNDELIVERED]);
    expect(chat.eventNotes[0].retryable).toBe(true);
    expect([chat.running, chat.runningSessions]).toEqual([false, []]);

    // 再切走、再切回：仍是一条气泡、一条说明
    await chat.open('B');
    expect([notes(chat), chat.messages.map(m => m.id)]).toEqual([[], ['b1']]);
    await chat.open('A');
    expect(chat.messages.filter(m => m.id === bubble.id)).toHaveLength(1);
    expect(notes(chat)).toEqual([UNDELIVERED]);

    await chat.retryLast();
    const sent = callsOf('chat.prompt');
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual({ sessionId: 'A', text: '断线时发的', attachments: ['att/a.png'], promptId });
    expect(chat.messages.filter(m => m.role === 'user' && m.id.startsWith('local-'))).toHaveLength(1);
    expect(chat.undelivered).toBeNull();
  });

  it('「没有送达」的气泡不被同会话的重取抹掉：open() 重取历史之后它还在末尾、只有一条，说明也只有一条', async () => {
    const chat = await boot({ active: 'A' });
    const { bubble } = await cutSend(chat);
    box.outcomes = refs => refs.map((r: any) => ({ ...r, status: 'not-accepted', error: '连接 MCP 失败' }));
    box.join = joinSnap(chat);
    goReconnecting();
    reconnectResume({ runs: [], inDoubt: [{ method: 'chat.prompt', params: {} }] });
    await drain();
    expect(notes(chat)).toEqual([UNDELIVERED]);
    expect(chat.eventNotes[0]).toMatchObject({ retryable: true, detail: '连接 MCP 失败' });
    box.history.A = [...box.history.A, msg('a3', 'assistant', '别处追加的一条')];
    await chat.open('A');                                        // 同会话重取（turnEnd / error 之后的自刷新、用户再点一次当前会话）
    expect(chat.messages.map(m => m.id)).toEqual(['a1', 'a2', 'a3', bubble.id]);
    expect(notes(chat)).toEqual([UNDELIVERED]);
    // 切走再回来，起跑前失败的原因还带着
    await chat.open('B');
    await chat.open('A');
    expect(chat.eventNotes.map(n => [n.short, n.retryable, n.detail])).toEqual([[UNDELIVERED, true, '连接 MCP 失败']]);
  });

  it('权限答复在途时切走：结局寄存到切回那个会话时才说，只说一次；「请重新选择」只在卡还待批时说', async () => {
    const respondAfterSwitch = async (chat: any): Promise<void> => {
      let reject!: (e: unknown) => void;
      box.respond = () => new Promise((_, rej) => { reject = rej; });
      const answering = chat.respondPerm('R1', 'allow-once');
      await drain();
      await chat.open('B');
      reject(inFlight());
      await answering;
      box.respond = undefined;
      expect(chat.inDoubtPerms).toEqual([{ requestId: 'R1', sessionId: 'A' }]);
    };
    const IN_DOUBT = [{ method: 'permission.respond', params: {} }];
    const initial = { runs: [run({ runId: 'rA' })], pendingPermissions: [permView()] };

    // ① 卡已按「允许」了结
    const chat = await boot({ initial, active: 'A' });
    await respondAfterSwitch(chat);
    box.outcomes = refs => refs.map((r: any) => ({ ...r, status: 'settled', source: 'broker', settled: { reason: 'answered', decision: 'allow' } }));
    box.join = joinSnap(chat, { runs: [run({ runId: 'rA' })] });
    goReconnecting();
    reconnectResume({ runs: [run({ runId: 'rA' })], perms: [], inDoubt: IN_DOUBT });
    await drain();
    expect([chat.activeId, notes(chat), chat.inDoubtPerms]).toEqual(['B', [], []]);       // 不串进乙的事件条
    await chat.open('A');
    expect(notes(chat)).toEqual(['这张权限卡已按「允许」处理。对应操作是否执行以对话里的工具结果为准']);
    await chat.open('B');
    await chat.open('A');
    expect(notes(chat)).toEqual([]);                                                    // 说过一次就不再说
    expect(callsOf('permission.respond')).toHaveLength(1);

    // ② 答复没有送达、卡重新出现：切回去时卡还在 → 说；卡已经没了 → 不说（那句话不再成立）
    for (const still of [true, false]) {
      const c = await boot({ initial, active: 'A' });
      await respondAfterSwitch(c);
      box.join = joinSnap(c, { runs: [run({ runId: 'rA' })], pendingPermissions: [permView()] });
      goReconnecting();
      reconnectResume({ runs: [run({ runId: 'rA' })], perms: [permView()], inDoubt: IN_DOUBT });
      await drain();
      expect([notes(c), c.pendingPerms.map(p => p.requestId), c.inDoubtPerms], String(still)).toEqual([[], ['R1'], []]);
      if (!still) handlers.get('permission.resolved')!({ requestId: 'R1', reason: 'answered' });
      await c.open('A');
      expect(notes(c), String(still)).toEqual(still ? ['连接中断时你的选择没有送达，请重新选择'] : []);
      expect(callsOf('state.outcomes'), String(still)).toEqual([]);
    }
  });

  it('进入终态时别的会话还有没核对的在途发送：不串进当前会话；手动重连之后切到那个会话才说「是否送达未知」', async () => {
    const chat = await boot({ active: 'A' });
    await cutSendAfterSwitch(chat);
    goReconnecting();
    box.hooks.status({ state: 'lost', attempt: 0, maxAttempts: 8, reason: 'exhausted' });
    box.onLost!();
    expect([chat.activeId, notes(chat), chat.inDoubtPrompts]).toEqual(['B', [], []]);
    box.hooks.status({ state: 'open', attempt: 0, maxAttempts: 8 });   // 手动重连成功
    await chat.open('A');
    expect(notes(chat)).toEqual(['连接中断时有一条消息是否送达未知，请查看对话后再决定是否重发']);
    expect(callsOf('chat.prompt')).toHaveLength(1);
  });
});

describe('F06 O 组 · 「没有送达」的那一条：发送被引擎拒绝时消息与重试入口都还在', () => {
  // 重试不经输入卡，没有草稿可交还：send() 开头摘掉的记录与气泡在被拒之后不放回的话，文字与附件引用就找不回来了
  const BUSY = '该会话正在运行中，请等待完成或取消';
  /** 甲上有一条核对出「没有送达」的消息（带附件），用户停在甲。 */
  async function undeliveredOnA(error?: string) {
    const chat = await boot({ active: 'A' });
    const { bubble, promptId } = await cutSend(chat);
    box.outcomes = refs => refs.map((r: any) => ({ ...r, status: 'not-accepted', ...(error ? { error } : {}) }));
    box.join = joinSnap(chat);
    goReconnecting();
    reconnectResume({ runs: [], inDoubt: [{ method: 'chat.prompt', params: {} }] });
    await drain();
    expect(chat.undelivered).toMatchObject({ sessionId: 'A', promptId });
    return { chat, bubble, promptId };
  }
  /** 让下一次 chat.prompt 挂着，返回拒绝它的函数。 */
  const hangPrompt = (): { reject(e: unknown): void } => {
    const h = { reject: (_e: unknown): void => undefined };
    box.prompt = () => new Promise((_, rej) => { h.reject = rej; });
    return h;
  };

  it('重试被拒（会话正在运行）：原因写进 lastError；气泡回到末尾、记录与带重试的说明原样留着；切走再切回仍在；再点重试沿用原 promptId', async () => {
    const { chat, bubble, promptId } = await undeliveredOnA('连接 MCP 失败');
    box.prompt = async () => { throw new Error(BUSY); };
    await chat.retryLast();
    expect(chat.lastError).toBe(BUSY);
    expect(chat.undelivered).toEqual({ sessionId: 'A', promptId, text: '断线时发的', attachments: ['att/a.png'], optimisticId: bubble.id, error: '连接 MCP 失败' });
    expect(chat.messages.map(m => m.id)).toEqual(['a1', 'a2', bubble.id]);       // 重发推的那条新气泡撤了，原来那条回到末尾
    const back = chat.messages[chat.messages.length - 1];
    expect([back.role, shapeOf(back.parts)]).toEqual([bubble.role, shapeOf(bubble.parts)]);   // 文字与附件引用都在
    expect(chat.eventNotes.map(n => [n.short, n.retryable, n.detail])).toEqual([[UNDELIVERED, true, '连接 MCP 失败']]);
    expect([chat.running, chat.runningSessions, chat.inDoubtPrompts]).toEqual([false, [], []]);
    expect(callsOf('chat.prompt').map(c => c.promptId)).toEqual([promptId, promptId]);

    // 切走再切回：仍是一条气泡、一条带重试的说明
    await chat.open('B');
    expect([notes(chat), chat.messages.map(m => m.id)]).toEqual([[], ['b1']]);
    await chat.open('A');
    expect(chat.messages.map(m => m.id)).toEqual(['a1', 'a2', bubble.id]);
    expect(chat.eventNotes.map(n => [n.short, n.retryable])).toEqual([[UNDELIVERED, true]]);

    // 引擎肯收了：再点重试，还是同一个 promptId、同一份文字与附件
    box.prompt = undefined;
    await chat.retryLast();
    const sent = callsOf('chat.prompt');
    expect(sent).toHaveLength(3);
    expect(sent[2]).toEqual({ sessionId: 'A', text: '断线时发的', attachments: ['att/a.png'], promptId });
    expect(chat.messages.filter(m => m.role === 'user' && m.id.startsWith('local-'))).toHaveLength(1);
    expect([chat.undelivered, chat.lastError]).toEqual([null, '']);
  });

  it('那一条还挂着时改发别的一条被拒：新的一条撤掉（草稿由输入卡交还），没送达的那一条原样留着；改发成功才把它放下', async () => {
    const { chat, bubble, promptId } = await undeliveredOnA();
    const NO_MODEL = '尚未配置任何模型 provider，请先在设置中添加';
    box.prompt = async () => { throw new Error(NO_MODEL); };
    await chat.send('另一条');
    expect(chat.lastError).toBe(NO_MODEL);
    expect(chat.undelivered).toEqual({ sessionId: 'A', promptId, text: '断线时发的', attachments: ['att/a.png'], optimisticId: bubble.id });
    expect(chat.messages.map(m => m.id)).toEqual(['a1', 'a2', bubble.id]);
    expect(chat.eventNotes.map(n => [n.short, n.retryable])).toEqual([[UNDELIVERED, true]]);
    const sent = callsOf('chat.prompt');
    expect(sent).toHaveLength(2);
    expect([sent[1].text, sent[1].promptId === promptId]).toEqual(['另一条', false]);          // 不是同一条消息：新的 promptId

    // 改发成功：用户放下了那一条——记录清掉、旧气泡不再接回（放回只发生在被拒时）
    box.prompt = undefined;
    await chat.send('另一条');
    expect(chat.undelivered).toBeNull();
    expect(chat.messages.some(m => m.id === bubble.id)).toBe(false);
    expect(notes(chat)).toEqual([]);
  });

  it('重试挂着时切到别的会话、随后被拒：不串进当前会话；切回原会话气泡与重试入口都在', async () => {
    const { chat, bubble, promptId } = await undeliveredOnA();
    const pending = hangPrompt();
    const retrying = chat.retryLast();
    await drain();
    await chat.open('B');
    pending.reject(new Error('会话已取消'));
    await retrying;
    box.prompt = undefined;
    expect([chat.activeId, notes(chat), chat.lastError, chat.runningSessions]).toEqual(['B', [], '', []]);
    expect(chat.messages.map(m => m.id)).toEqual(['b1']);
    expect(chat.undelivered).toMatchObject({ sessionId: 'A', promptId, text: '断线时发的', attachments: ['att/a.png'] });

    await chat.open('A');
    expect(chat.messages.map(m => m.id)).toEqual(['a1', 'a2', bubble.id]);
    expect(chat.eventNotes.map(n => [n.short, n.retryable])).toEqual([[UNDELIVERED, true]]);
    await chat.retryLast();
    expect(callsOf('chat.prompt').map(c => c.promptId)).toEqual([promptId, promptId, promptId]);
  });

  it('重试挂着时那个会话被删了：不放回（删了就没了，同一个 id 日后被带回来也不带着这条旧消息）', async () => {
    const { chat } = await undeliveredOnA();
    const pending = hangPrompt();
    const retrying = chat.retryLast();
    await drain();
    await chat.open('B');
    box.sessions = [{ id: 'B', title: 'B' }];
    await chat.deleteSession('A');
    pending.reject(new Error('会话已取消'));
    await retrying;
    expect(chat.goneSessions).toContain('A');
    expect([chat.undelivered, chat.activeId, notes(chat), chat.lastError]).toEqual([null, 'B', [], '']);
  });

  it('槽位只有一个：重试挂着的这段时间里别的会话核对出了新的一条「没有送达」，被拒时不覆盖它', async () => {
    const { chat } = await undeliveredOnA();
    // 乙也有一条发送的应答随断线丢了，还没核对
    await chat.open('B');
    const other = await cutSend(chat, '乙的一条');
    await chat.open('A');
    const pending = hangPrompt();
    const retrying = chat.retryLast();
    await drain();
    // 一轮补洞的同步把乙的那条核对出来：没有送达
    reconnectResume({ cause: 'gap', runs: [], skipOpen: true });
    await drain();
    expect(chat.undelivered).toMatchObject({ sessionId: 'B', promptId: other.promptId });
    pending.reject(new Error(BUSY));
    await retrying;
    expect(chat.undelivered).toMatchObject({ sessionId: 'B', promptId: other.promptId, text: '乙的一条' });
    expect(chat.lastError).toBe(BUSY);
  });
});

describe('F06 O 组 · 会话删除后同一个 id 被带回来', () => {
  it('旧的 run 记录随会话一起作废：generation 从 1 重来的新 run，正文、步骤卡照常应用，turnEnd 收得了尾；别处起的也点得亮', async () => {
    const chat = await boot({ active: 'A' });
    emit('A', { kind: 'textDelta', text: '旧的一轮' }, { id: 'r-old', generation: 1 });
    emit('A', { kind: 'turnEnd', stopReason: 'endTurn' }, { id: 'r-old', generation: 1 });
    await drain();
    expect(chat.runOf.A).toEqual({ runId: 'r-old', generation: 1, ended: true });
    // 删除（引擎连 run 行一起删）；随后对端同步把同一个 id 带回来，generation 从 1 重来
    box.sessions = [{ id: 'B', title: 'B' }];
    await chat.deleteSession('A');
    expect([chat.goneSessions, chat.runOf.A, chat.activeId]).toEqual([['A'], undefined, 'B']);
    emit('A', { kind: 'textDelta', text: '删除后晚到的' }, { id: 'r-old', generation: 1 });   // 消失期间由 goneSessions 挡着
    expect(chat.runningSessions).toEqual([]);
    box.sessions = [{ id: 'A', title: 'A' }, { id: 'B', title: 'B' }];
    box.history.A = [];
    await chat.refreshSessions();
    expect(chat.goneSessions).toEqual([]);

    // 别处在带回来的会话里起了一次 run（本窗口停在乙）：点得亮
    emit('A', { kind: 'textDelta', text: 'x' }, { id: 'r-other', generation: 1 });
    expect(chat.runningSessions).toEqual(['A']);
    emit('A', { kind: 'turnEnd', stopReason: 'endTurn' }, { id: 'r-other', generation: 1 });
    expect(chat.runningSessions).toEqual([]);

    // 再删一次、再带回来，这回本窗口自己发：应答里 generation 又是 1
    box.sessions = [{ id: 'B', title: 'B' }];
    await chat.refreshSessions();
    box.sessions = [{ id: 'A', title: 'A' }, { id: 'B', title: 'B' }];
    await chat.refreshSessions();
    await chat.open('A');
    box.prompt = async () => ({ ok: true, runId: 'r-fresh', generation: 1, duplicate: false, state: 'running' });
    await chat.send('带回来之后再问');
    expect(chat.runOf.A).toEqual({ runId: 'r-fresh', generation: 1, ended: false });
    emit('A', { kind: 'textDelta', text: '新的正文' }, { id: 'r-fresh', generation: 1 });
    emit('A', { kind: 'toolStart', toolUseId: 't1', name: 'shell', title: '跑命令' }, { id: 'r-fresh', generation: 1 });
    expect([chat.streamingText, chat.toolCards.length, chat.running]).toEqual(['新的正文', 1, true]);
    emit('A', { kind: 'turnEnd', stopReason: 'endTurn' }, { id: 'r-fresh', generation: 1 });
    await drain();
    expect([chat.running, chat.runningSessions]).toEqual([false, []]);
    expect(chat.runOf.A).toEqual({ runId: 'r-fresh', generation: 1, ended: true });
  });
});

describe('F06 O 组 · 连上之后不再说「正在重新连接」', () => {
  it('重连期间按 Enter / 点停止写下的那一句、终态时写下的「已断开」，连上的那一刻清掉；别的错误原样留着', async () => {
    const chat = await boot({ initial: { runs: [run({ runId: 'rA' })] }, active: 'A' });
    goReconnecting();
    await chat.send('这时发的');
    expect(chat.lastError).toBe('正在重新连接后台服务，连上后再发送');   // 输入卡见它才把草稿交回框里
    box.hooks.status({ state: 'open', attempt: 0, maxAttempts: 8 });
    expect([chat.connection, chat.lastError]).toEqual(['ok', '']);

    goReconnecting();
    await chat.cancel();
    expect(chat.lastError).toBe('连接恢复后才能停止');
    box.join = joinSnap(chat, { runs: [run({ runId: 'rA' })] });
    reconnectResume({ runs: [run({ runId: 'rA' })] });                  // 走完整的一轮：开闸、校正、收尾
    await drain();
    expect([chat.connection, chat.lastError, chat.running]).toEqual(['ok', '', true]);
    expect(methods()).not.toContain('chat.prompt');
    expect(methods()).not.toContain('chat.cancel');

    // 终态之后手动重连成功
    goReconnecting();
    box.hooks.status({ state: 'lost', attempt: 0, maxAttempts: 8, reason: 'exhausted' });
    box.onLost!();
    await chat.send('终态时发的');
    expect(chat.lastError).toBe(LOST);
    box.hooks.status({ state: 'open', attempt: 0, maxAttempts: 8 });
    expect(chat.lastError).toBe('');

    // 不是这三句的错误不清
    goReconnecting();
    chat.lastError = '套用助手失败：助手不存在';
    box.hooks.status({ state: 'open', attempt: 0, maxAttempts: 8 });
    expect(chat.lastError).toBe('套用助手失败：助手不存在');
  });

  it('回放里的 error 事件写的 lastError 在开闸之后才到：留着', async () => {
    const chat = await boot({ initial: { runs: [run({ runId: 'rA' })] }, active: 'A' });
    goReconnecting();
    await chat.send('这时发的');
    box.join = joinSnap(chat, { runs: [run({ runId: 'rA', state: 'failed', stopReason: 'error', stopDetail: '模型端点 500' })] });
    reconnectResume({ events: [{ method: 'chat.event', params: evt('A', { kind: 'error', message: '模型端点 500' }, { id: 'rA' }) }], runs: [] });
    await drain();
    expect(chat.lastError).toBe('模型端点 500');
  });
});

describe('F06 O 组 · 收口时的错误条与 error 事件同一口径', () => {
  /** 正跟踪的 run 在快照里已是 failed（它的 error 事件没有到过这条连接）。 */
  async function concluded(o: Record<string, unknown>) {
    const chat = await boot({ initial: { runs: [run({ runId: 'rA' })] }, active: 'A' });
    const s = snap({ runs: [run({ runId: 'rA', state: 'failed', ...o })], session: { sessionId: 'A', exists: true, messages: box.history.A } });
    box.hooks.applySnapshot(s, { reason: 'window-expired', cause: 'reconnect', epochChanged: false });
    expect(chat.eventNotes).toHaveLength(1);
    const { kind, detail, retryable, short, relay } = chat.eventNotes[0] as any;
    return { chat, note: { kind, detail, retryable, short, relay } };
  }

  it('普通失败、这次 run 落过 user 消息：给重试；起跑前失败（没落消息）不给——重试会重发更早的一条', async () => {
    const a = await concluded({ stopReason: 'error', stopDetail: 'HTTP 502', userMessageId: 'a1' });
    expect(a.note).toEqual({ kind: 'error', detail: 'HTTP 502', retryable: true, short: undefined, relay: undefined });
    expect([a.chat.lastError, a.chat.running]).toEqual(['HTTP 502', false]);
    const b = await concluded({ stopReason: 'start-failed', stopDetail: '连接 MCP 失败' });
    expect(b.note).toMatchObject({ detail: '连接 MCP 失败', retryable: false });
  });

  it('按 code 分流：上下文已满 / 思考块绑定 / 能力不符 / 请求放不下不给重试，短句按 code；输出截断给重试', async () => {
    const shorts: Record<string, string> = {
      contextFull: '上下文已满，当前模型放不下这段对话',
      thinkingBinding: 'Claude 拒绝回放历史思考块，请新建会话继续',
      capability: '没有能处理这条消息的模型，未发送',
      requestBudget: '请求放不下：系统提示与工具定义占满了模型的输入上限',
    };
    for (const [code, short] of Object.entries(shorts)) {
      const r = await concluded({ stopReason: code, stopDetail: `原始报文（500）${code}`, userMessageId: 'a1' });
      expect(r.note, code).toEqual({ kind: 'error', detail: `原始报文（500）${code}`, retryable: false, short, relay: undefined });
    }
    const out = await concluded({ stopReason: 'outputLimit', stopDetail: 'max_tokens 用完', userMessageId: 'a1' });
    expect(out.note).toMatchObject({ retryable: true, short: '输出被 max_tokens 截断，没有产出正文' });
  });
});

describe('F06 O 组 · 重载后回到原会话', () => {
  it('open() 记下当前会话；新的 store 在 init() 末尾回到它；落到欢迎页时清掉；会话已不在列表里就留在欢迎页', async () => {
    const mem = new Map<string, string>();
    (globalThis as any).sessionStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); }, removeItem: (k: string) => { mem.delete(k); } };
    const first = await boot({ active: 'B' });
    expect(mem.get('deskminis.activeSession')).toBe('B');
    expect(first.activeId).toBe('B');
    const reloaded = await boot();                               // 「重载」：新的 pinia、新的 store
    expect(reloaded.activeId).toBe('B');
    expect(reloaded.messages.map(m => m.id)).toEqual(['b1']);
    box.sessions = [{ id: 'A', title: 'A' }];
    const gone = await boot();
    expect(gone.activeId).toBe('');
    mem.set('deskminis.activeSession', 'A');
    const again = await boot();
    box.sessions = [];
    await again.deleteSession('A');
    expect(again.activeId).toBe('');
    expect(mem.has('deskminis.activeSession')).toBe(false);
  });
});

describe('F06 整合 · 与 F11B / F08 的交界：会话消失之后不留指向它的东西', () => {
  // F11B 之后会话有四条消失的路：本窗口删除、生命周期广播（别的窗口 / 别的设备）、会话列表广播、快照（断线期间被删）。
  // 谁先到都一样：运行标记、待批卡、在途与「没有送达」的提交、重载记忆，都不再指向它。
  const REMOTE_NOTE = '刚才打开的会话已在另一台设备上删除';
  const hang = (): { p: Promise<any>; resolve(v?: unknown): void; reject(e: unknown): void } => {
    let resolve!: (v?: unknown) => void; let reject!: (e: unknown) => void;
    const p = new Promise<any>((res, rej) => { resolve = res; reject = rej; });
    return { p, resolve, reject };
  };
  const memStorage = (): Map<string, string> => {
    const mem = new Map<string, string>();
    (globalThis as any).sessionStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); }, removeItem: (k: string) => { mem.delete(k); } };
    return mem;
  };
  const lifecycle = (o: Record<string, unknown>): void => handlers.get('chat.sessions.lifecycle')!({ sessionId: 'A', v: 1, byDevice: 'dev', ...o });
  const sessionsChanged = (): void => handlers.get('chat.sessions.changed')!({});
  /** 甲上有一条核对出「没有送达」的消息，用户停在甲。 */
  async function undeliveredOnA() {
    const chat = await boot({ active: 'A' });
    const { bubble, promptId } = await cutSend(chat);
    box.outcomes = refs => refs.map((r: any) => ({ ...r, status: 'not-accepted' }));
    box.join = joinSnap(chat);
    goReconnecting();
    reconnectResume({ runs: [], inDoubt: [{ method: 'chat.prompt', params: {} }] });
    await drain();
    expect(chat.undelivered).toMatchObject({ sessionId: 'A', promptId });
    return { chat, bubble, promptId };
  }
  /** 点了重试、chat.prompt 挂在起跑阶段；返回拒绝它的函数与 retryLast 的 promise。 */
  async function retryHanging(chat: any) {
    const prompt = hang();
    box.prompt = () => prompt.p;
    const retrying = chat.retryLast();
    await drain();
    expect(chat.runningSessions).toEqual(['A']);
    return { prompt, retrying };
  }
  function expectNoTraceOf(chat: any, sid: string): void {
    expect(chat.undelivered, '没有送达的那一条').toBeNull();
    expect(chat.runningSessions, '运行标记').not.toContain(sid);
    expect(chat.pendingPerms.filter((p: any) => p.sessionId === sid), '待批卡').toEqual([]);
    expect(chat.inDoubtPrompts.filter((p: any) => p.sessionId === sid), '待核对的发送').toEqual([]);
    expect(chat.inDoubtPerms.filter((p: any) => p.sessionId === sid), '待核对的权限答复').toEqual([]);
    expect(Object.keys(chat.runOf), '跟踪的 run').not.toContain(sid);
    expect(Object.keys(chat.pendingStarts), '别处起跑的 run').not.toContain(sid);
    expect(chat.activeId, '当前会话').not.toBe(sid);
    expect(chat.goneSessions).toContain(sid);
  }

  it('R2-1 本窗口删除，真实时序（引擎先停 run：重试的「已取消」应答先到，删除的应答后到）：放回去的那一条随会话一起清掉；落到别的会话；同一个 id 日后被带回来也不带着它', async () => {
    const mem = memStorage();
    const { chat } = await undeliveredOnA();
    expect(mem.get('deskminis.activeSession')).toBe('A');
    const { prompt, retrying } = await retryHanging(chat);
    const del = hang();
    box.lists = { 'chat.sessions.delete': () => del.p };
    const deleting = chat.deleteSession('A');
    await drain();
    prompt.reject(new Error('会话已取消'));
    await retrying;
    box.prompt = undefined;
    // 这一刻删除还没有答复，会话不在 goneSessions 里：send() 的 catch 把那一条放回去了
    expect(chat.goneSessions).not.toContain('A');
    expect(chat.undelivered).toMatchObject({ sessionId: 'A' });
    box.sessions = [{ id: 'B', title: 'B' }];
    del.resolve({ ok: true });
    await deleting;
    await drain();
    expectNoTraceOf(chat, 'A');
    expect([chat.activeId, chat.messages.map((m: any) => m.id), notes(chat), chat.lastError, chat.running]).toEqual(['B', ['b1'], [], '', false]);
    expect(mem.get('deskminis.activeSession')).toBe('B');

    // 同一个 id 被对端同步带回来：没有旧气泡、没有重试入口
    box.sessions = [{ id: 'A', title: 'A' }, { id: 'B', title: 'B' }];
    sessionsChanged();
    await drain();
    await chat.open('A');
    expect([chat.messages.map((m: any) => m.id), notes(chat), chat.undelivered]).toEqual([['a1', 'a2'], [], null]);
  });

  it('R2-1 本窗口删除、没有别的会话：落到欢迎页，那一条同样清掉，重载记忆清掉', async () => {
    const mem = memStorage();
    box.sessions = [{ id: 'A', title: 'A' }];
    const { chat } = await undeliveredOnA();
    const { prompt, retrying } = await retryHanging(chat);
    const del = hang();
    box.lists = { 'chat.sessions.delete': () => del.p };
    const deleting = chat.deleteSession('A');
    await drain();
    prompt.reject(new Error('会话已取消'));
    await retrying;
    box.prompt = undefined;
    expect(chat.undelivered).toMatchObject({ sessionId: 'A' });
    box.sessions = [];
    del.resolve({ ok: true });
    await deleting;
    await drain();
    expectNoTraceOf(chat, 'A');
    expect([chat.activeId, chat.messages, notes(chat), chat.lastError, chat.running]).toEqual(['', [], [], '', false]);
    expect(mem.has('deskminis.activeSession')).toBe(false);
  });

  it('R2-1 别的窗口删除（重试的「已取消」应答先到，生命周期广播后到）：那一条清掉、切到别的会话；本机删的不说「另一台设备」', async () => {
    const { chat } = await undeliveredOnA();
    const { prompt, retrying } = await retryHanging(chat);
    prompt.reject(new Error('会话已取消'));
    await retrying;
    box.prompt = undefined;
    expect(chat.undelivered).toMatchObject({ sessionId: 'A' });
    expect(chat.goneSessions).not.toContain('A');
    box.sessions = [{ id: 'B', title: 'B' }];
    lifecycle({ kind: 'deleted', origin: 'local' });     // 引擎的顺序：生命周期广播在前，chat.sessions.changed 在后
    sessionsChanged();
    await drain();
    expectNoTraceOf(chat, 'A');
    expect([chat.activeId, chat.messages.map((m: any) => m.id), notes(chat), chat.lastError]).toEqual(['B', ['b1'], [], '']);
  });

  it('R2-1 别的设备删除（对端墓碑）：那一条清掉；切到别的会话并说明「已在另一台设备上删除」；保留副本列表重拉', async () => {
    const { chat } = await undeliveredOnA();
    const { prompt, retrying } = await retryHanging(chat);
    prompt.reject(new Error('会话已取消'));
    await retrying;
    box.prompt = undefined;
    expect(chat.undelivered).toMatchObject({ sessionId: 'A' });
    box.sessions = [{ id: 'B', title: 'B' }];
    box.lists = { 'chat.sessions.listRetained': async () => [{ id: 'A', title: 'A' }] };
    sessionsChanged();                                   // 对端墓碑落地：chat.sessions.changed 在前，生命周期广播在后
    lifecycle({ kind: 'tombstone-applied', origin: 'remote', viaPeer: 'fp', retained: true, unseenCount: 1 });
    await drain();
    expectNoTraceOf(chat, 'A');
    expect([chat.activeId, chat.messages.map((m: any) => m.id), notes(chat)]).toEqual(['B', ['b1'], [REMOTE_NOTE]]);
    expect(chat.retainedSessions.map((s: any) => s.id)).toEqual(['A']);
  });

  it('别的设备删除一个正在跑、挂着权限卡的当前会话（引擎先了结卡、停 run，再广播）：卡与运行标记都摘掉，说明仍然出现；晚到的事件不复活它', async () => {
    const chat = await boot({ initial: { runs: [run({ runId: 'rA' })], pendingPermissions: [permView()] }, active: 'A' });
    expect([chat.running, chat.pendingPerms.map((p: any) => p.requestId), chat.runningSessions]).toEqual([true, ['R1'], ['A']]);
    box.sessions = [{ id: 'B', title: 'B' }];
    handlers.get('permission.resolved')!({ requestId: 'R1', reason: 'cancelled' });
    emit('A', { kind: 'error', message: '会话已取消' }, { id: 'rA' });
    sessionsChanged();
    lifecycle({ kind: 'tombstone-applied', origin: 'remote', viaPeer: 'fp', retained: false });
    await drain();
    expectNoTraceOf(chat, 'A');
    expect([chat.activeId, chat.running, notes(chat), chat.lastError]).toEqual(['B', false, [REMOTE_NOTE], '']);
    emit('A', { kind: 'textDelta', text: '晚到的增量' }, { id: 'rA' });
    emit('A', { kind: 'textDelta', text: '更晚一次 run' }, { id: 'rA2', generation: 2 });
    expect([chat.runningSessions, chat.streamingText, Object.keys(chat.runOf)]).toEqual([[], '', []]);
  });

  it('别的设备删掉唯一的会话（它正在跑、本窗口是中途接上的）：经生命周期广播落到欢迎页，F06 的占位 / 尾巴状态与重载记忆一并清掉', async () => {
    const mem = memStorage();
    box.sessions = [{ id: 'A', title: 'A' }];
    const chat = await boot({ initial: { runs: [run({ runId: 'rA' })] }, active: 'A' });
    expect([chat.running, chat.midRun, mem.get('deskminis.activeSession')]).toEqual([true, true, 'A']);
    box.sessions = [];
    sessionsChanged();
    lifecycle({ kind: 'tombstone-applied', origin: 'remote', viaPeer: 'fp', retained: false });
    await drain();
    expectNoTraceOf(chat, 'A');
    expect([chat.activeId, chat.messages, chat.running, chat.midRun, chat.joinedTail, notes(chat), chat.lastError]).toEqual(['', [], false, false, false, [], '']);
    expect(mem.has('deskminis.activeSession')).toBe(false);
  });

  it('断线期间当前会话在别处被删，断线时有一条在途的发送；重连走快照：落到欢迎页，不查询、不重发，不留「没有送达」，运行标记与重载记忆都清掉', async () => {
    const mem = memStorage();
    const chat = await boot({ active: 'A' });
    await cutSend(chat);
    expect([chat.inDoubtPrompts.length, chat.runningSessions]).toEqual([1, ['A']]);
    goReconnecting();
    box.sessions = [{ id: 'B', title: 'B' }];
    box.outcomes = refs => refs.map((r: any) => ({ ...r, status: 'not-accepted', error: '会话已删除' }));
    box.hooks.status({ state: 'open', attempt: 0, maxAttempts: 8 });
    box.hooks.applySnapshot(snap({ session: { sessionId: 'A', exists: false, messages: [] } }), { reason: 'window-expired', cause: 'reconnect', epochChanged: false });
    box.hooks.synced({ via: 'snapshot', cause: 'reconnect', epochChanged: false, revision: 1, missed: false, inDoubt: [{ method: 'chat.prompt', params: {} }] });
    await drain();
    expectNoTraceOf(chat, 'A');
    expect([chat.activeId, chat.messages, notes(chat), chat.lastError, chat.running, chat.connection]).toEqual(['', [], [], '', false, 'ok']);
    expect(mem.has('deskminis.activeSession')).toBe(false);
    expect(callsOf('chat.prompt')).toHaveLength(1);
    expect(callsOf('state.outcomes')).toEqual([]);
  });

  for (const status of ['not-accepted', 'accepted'] as const) {
    it(`核对在途发送的查询挂着时那个会话被删了，随后答复「${status}」：只摘条目，不留「没有送达」、不记 run、不标在跑`, async () => {
      const chat = await boot({ active: 'A' });
      const { promptId } = await cutSendAfterSwitch(chat);
      const oc = hang();
      box.lists = { 'state.outcomes': () => oc.p };
      box.join = joinSnap(chat);
      goReconnecting();
      reconnectResume({ runs: [], inDoubt: [{ method: 'chat.prompt', params: {} }] });
      await drain();
      expect(callsOf('state.outcomes')).toHaveLength(1);
      box.sessions = [{ id: 'B', title: 'B' }];
      lifecycle({ kind: 'deleted', origin: 'local' });
      sessionsChanged();
      await drain();
      const o = status === 'accepted'
        ? { status, run: run({ runId: 'r-acc', generation: 2, state: 'cancelled', stopReason: 'session-deleted', promptId, userMessageId: 'a3' }) }
        : { status };
      oc.resolve({ epoch: 1, instanceId: 'I', outcomes: [{ kind: 'prompt', sessionId: 'A', promptId, ...o }] });
      await drain();
      expectNoTraceOf(chat, 'A');
      expect([chat.activeId, notes(chat), chat.lastError, chat.messages.map((m: any) => m.id)]).toEqual(['B', [], '', ['b1']]);
      expect(callsOf('chat.prompt')).toHaveLength(1);
    });
  }

  it('断线期间被删的会话上有一次在途的权限答复：重连走快照后不查询、不寄存说明——同一个 id 日后被带回来，切过去没有那句旧话', async () => {
    const chat = await boot({ initial: { runs: [run({ runId: 'rA' })], pendingPermissions: [permView()] }, active: 'A' });
    const answer = hang();
    box.respond = () => answer.p;
    const responding = chat.respondPerm('R1', 'allow-once');
    await drain();
    await chat.open('B');
    answer.reject(inFlight());
    await responding;
    box.respond = undefined;
    expect(chat.inDoubtPerms).toEqual([{ requestId: 'R1', sessionId: 'A' }]);
    goReconnecting();
    box.sessions = [{ id: 'B', title: 'B' }];
    box.outcomes = refs => refs.map((r: any) => ({ ...r, status: 'settled', source: 'broker', settled: { reason: 'cancelled', cause: 'session-deleted' } }));
    box.hooks.status({ state: 'open', attempt: 0, maxAttempts: 8 });
    box.hooks.applySnapshot(snap({ session: { sessionId: 'B', exists: true, messages: [...box.history.B] } }), { reason: 'window-expired', cause: 'reconnect', epochChanged: false });
    box.hooks.synced({ via: 'snapshot', cause: 'reconnect', epochChanged: false, revision: 1, missed: false, inDoubt: [{ method: 'permission.respond', params: {} }] });
    await drain();
    expectNoTraceOf(chat, 'A');
    expect([chat.activeId, notes(chat)]).toEqual(['B', []]);
    expect(callsOf('state.outcomes')).toEqual([]);
    expect(callsOf('permission.respond')).toHaveLength(1);
    // 带回来之后切过去：没有寄存的说明
    box.sessions = [{ id: 'A', title: 'A' }, { id: 'B', title: 'B' }];
    sessionsChanged();
    await drain();
    await chat.open('A');
    expect(notes(chat)).toEqual([]);
  });

  it('装完快照之后才交付的生命周期广播（水位之前缓冲着、快照没覆盖的帧）：当前会话已由快照落到欢迎页，这一帧只重拉保留副本，不再动视图', async () => {
    const chat = await boot({ active: 'A' });
    box.sessions = [{ id: 'B', title: 'B' }];
    box.lists = { 'chat.sessions.listRetained': async () => [{ id: 'A', title: 'A' }] };
    box.hooks.applySnapshot(snap({ session: { sessionId: 'A', exists: false, messages: [] } }), { reason: 'no-cursor', cause: 'gap', epochChanged: false });
    expect(chat.activeId).toBe('');
    lifecycle({ kind: 'tombstone-applied', origin: 'remote', viaPeer: 'fp', retained: true, unseenCount: 1 });
    await drain();
    expectNoTraceOf(chat, 'A');
    expect([chat.activeId, chat.messages, notes(chat)]).toEqual(['', [], []]);
    expect(chat.retainedSessions.map((s: any) => s.id)).toEqual(['A']);
  });

  it('重连之后的整体刷新带上 F11B 的保留副本列表，并给自己取数的组件（F08 的「改动」清单与审阅面板）一个重取记号；不是重连的续传不刷新', async () => {
    const chat = await boot({ active: 'A' });
    box.lists = { 'chat.sessions.listRetained': async () => [{ id: 'Z', title: '留着的' }] };
    box.join = joinSnap(chat);
    const tick = chat.refreshTick;
    expect(typeof tick).toBe('number');
    goReconnecting();
    reconnectResume({ runs: [] });
    await drain();
    expect(methods()).toContain('chat.sessions.listRetained');
    expect(chat.retainedSessions).toEqual([{ id: 'Z', title: '留着的' }]);
    expect(chat.refreshTick).toBe(tick + 1);
    rpcCallMock.mockClear();
    reconnectResume({ cause: 'gap', runs: [], skipOpen: true });
    await drain();
    expect(methods()).not.toContain('chat.sessions.listRetained');
    expect(chat.refreshTick).toBe(tick + 1);
    // join 的水位之前有帧没到齐（missed）：丢的可能正是 checkpoints.changed / 生命周期广播 → 刷新
    reconnectResume({ cause: 'gap', runs: [], skipOpen: true, missed: true });
    await drain();
    expect(methods()).toContain('chat.sessions.listRetained');
    expect(chat.refreshTick).toBe(tick + 2);
  });

  // 权限答复的结局（sessionNote）不寄存给已消失的会话。markGone 清的是条目，查询挂着时条目已经被 settleInDoubt 取在手里：
  // 结论到达后那一句没有地方说——当前会话已经换成别的，寄存下来的话同一个 id 日后被带回来、切过去就显示一句删除之前的旧话
  for (const c of [
    { where: '用户停在那个会话上', stay: true, outcome: { status: 'settled', source: 'broker', settled: { reason: 'answered', decision: 'allow' } } },
    { where: '用户已切到别的会话', stay: false, outcome: { status: 'unknown' } },
  ]) {
    it(`核对在途权限答复的查询挂着时那个会话被删了（${c.where}），随后答复「${c.outcome.status}」：不寄存说明——同一个 id 日后被带回来，切过去没有那句旧话`, async () => {
      const chat = await boot({ initial: { runs: [run({ runId: 'rA' })], pendingPermissions: [permView()] }, active: 'A' });
      const answer = hang();
      box.respond = () => answer.p;
      const responding = chat.respondPerm('R1', 'allow-once');
      await drain();
      if (!c.stay) await chat.open('B');
      answer.reject(inFlight());
      await responding;
      box.respond = undefined;
      expect(chat.inDoubtPerms).toEqual([{ requestId: 'R1', sessionId: 'A' }]);
      // 重连走续传、卡不在应答里：查 state.outcomes，查询挂着
      const oc = hang();
      box.lists = { 'state.outcomes': () => oc.p };
      box.join = joinSnap(chat, { runs: [run({ runId: 'rA' })] });
      goReconnecting();
      reconnectResume({ runs: [run({ runId: 'rA' })], perms: [], inDoubt: [{ method: 'permission.respond', params: {} }] });
      await drain();
      expect(callsOf('state.outcomes')).toEqual([{ refs: [{ kind: 'permission', requestId: 'R1' }] }]);
      // 查询挂着时甲被删（引擎先停 run，再广播）
      box.sessions = [{ id: 'B', title: 'B' }];
      emit('A', { kind: 'error', message: '会话已取消' }, { id: 'rA' });
      lifecycle({ kind: 'deleted', origin: 'local' });
      sessionsChanged();
      await drain();
      expect(chat.activeId).toBe('B');
      oc.resolve({ epoch: 1, instanceId: 'I', outcomes: [{ kind: 'permission', requestId: 'R1', ...c.outcome }] });
      await drain();
      expectNoTraceOf(chat, 'A');
      expect([chat.activeId, notes(chat), chat.lastError]).toEqual(['B', [], '']);
      expect(callsOf('permission.respond')).toHaveLength(1);
      // 同一个 id 被对端同步带回来，切过去：事件条里没有那次答复的结局
      box.sessions = [{ id: 'A', title: 'A' }, { id: 'B', title: 'B' }];
      sessionsChanged();
      await drain();
      expect(chat.goneSessions).not.toContain('A');
      await chat.open('A');
      expect([chat.activeId, notes(chat)]).toEqual(['A', []]);
    });
  }

  // 断线期间当前会话被删、重连走续传：回放里有生命周期广播，这条路知道是谁删的——落点与那一句同在线时一样（F11B）。
  // 线上的先后：回放帧的处理器发出的 chat.sessions.list 排在 afterSync 取的带会话快照之前，应答也先到；
  // 保留副本列表要是排在切走之前取，它的应答在那份快照之后——快照先把视图拉到欢迎页，切走的那一步见 activeId 已空就不做了
  for (const c of [
    { who: '别的设备（对端墓碑）', remote: true },
    { who: '本机别的窗口', remote: false },
  ]) {
    it(`断线期间当前会话被${c.who}删掉、另有别的会话，重连走续传：落到别的会话，${c.remote ? '并说明「已在另一台设备上删除」' : '不说「另一台设备」'}；带着旧会话取的快照晚到也不把视图拉到欢迎页`, async () => {
      const mem = memStorage();
      const chat = await boot({ active: 'A' });
      const snapGate = hang(); const retained = hang();
      resyncMock.mockImplementation(async () => {
        const asked = chat.activeId;                       // 请求发出那一刻带的会话
        await snapGate.p;
        const s = snap({ session: { sessionId: asked, exists: box.sessions.some(x => x.id === asked), messages: [...(box.history[asked] ?? [])] } });
        box.hooks.applySnapshot(s, { reason: 'no-cursor', cause: 'join', epochChanged: false });
        box.hooks.synced?.({ via: 'snapshot', cause: 'join', epochChanged: false, revision: s.revision, missed: false, inDoubt: [] });
      });
      box.lists = { 'chat.sessions.listRetained': () => retained.p };
      goReconnecting();
      box.sessions = [{ id: 'B', title: 'B' }];
      const life = { method: 'chat.sessions.lifecycle', params: { sessionId: 'A', v: 1, byDevice: 'dev',
        ...(c.remote ? { kind: 'tombstone-applied', origin: 'remote', viaPeer: 'fp', retained: true, unseenCount: 1 } : { kind: 'deleted', origin: 'local' }) } };
      const changed = { method: 'chat.sessions.changed', params: {} };
      // 引擎的顺序：对端墓碑落地是 changed 在前、生命周期广播在后；本机删除反过来
      reconnectResume({ events: c.remote ? [changed, life] : [life, changed], runs: [] });
      await drain();
      expect(resyncMock).toHaveBeenCalledTimes(1);          // 带着甲取的那一份，还没答
      snapGate.resolve();
      await drain();
      retained.resolve(c.remote ? [{ id: 'A', title: 'A' }] : []);
      await drain();
      expectNoTraceOf(chat, 'A');
      expect([chat.activeId, chat.messages.map((m: any) => m.id), notes(chat), chat.lastError, chat.running, chat.connection])
        .toEqual(['B', ['b1'], c.remote ? [REMOTE_NOTE] : [], '', false, 'ok']);
      expect(mem.get('deskminis.activeSession')).toBe('B');
      expect(chat.retainedSessions.map((s: any) => s.id)).toEqual(c.remote ? ['A'] : []);
      expect(methods().filter(m => m === 'chat.prompt' || m === 'permission.respond' || m === 'chat.sessions.delete')).toEqual([]);
    });
  }
});
