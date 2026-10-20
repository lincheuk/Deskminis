/**
 * Q14 · 渲染端取历史只取增量（store 这一侧）。
 *
 * 真跑 store；rpc 是桩，其中 chat.messages.list 背后是一份真的 ChatStore（内存库），应答过一遍 JSON 模拟线上。
 * 桩里那三行与 index.ts 的处理器写法相同（处理器本身由 tests/renderer-history-incremental.test.ts 经真实引擎覆盖）。
 *
 * 钉的行为：
 *  - 什么时候带 have、带的是什么（乐观气泡不算在内）；什么时候不带（换了会话、收到同步通知、连接断过）；
 *  - 应答怎么用：{ append } 接在后面，数组整体替换（引擎判断接不上，或旧引擎不认 have）；
 *  - 不管走哪条路，messages 里落库的那一段都与引擎的完整列表相同；每次都是一个新数组。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { rpcCallMock, handlers } = vi.hoisted(() => ({
  rpcCallMock: vi.fn(),
  handlers: new Map<string, (p: any) => void>(),
}));

vi.mock('../src/renderer/src/rpc', () => ({
  rpc: {
    call: rpcCallMock,
    connect: async () => {},
    on: (method: string, h: (p: any) => void) => { handlers.set(method, h); },
    onLost: vi.fn(),
  },
}));

// eslint-disable-next-line import/first —— vi.mock 由 vitest 提升到顶部，此处 import 拿到的是桩
import { createPinia, setActivePinia } from 'pinia';
// eslint-disable-next-line import/first
import { toRaw } from 'vue';
// eslint-disable-next-line import/first
import { useChat } from '../src/renderer/src/stores/chat';
// eslint-disable-next-line import/first
import { openDb } from '../src/minisd/store/db';
// eslint-disable-next-line import/first
import { ChatStore } from '../src/minisd/store/chat-store';
// eslint-disable-next-line import/first
import type { SyncPayload } from '../src/minisd/sync/wire';

type Chat = ReturnType<typeof useChat>;
interface ListCall { sessionId: string; have?: { count: number; lastId?: string } }

let engine: ChatStore;
let A: string;
let B: string;
/** 渲染端发过的 chat.messages.list，按顺序：参数与应答的形态。 */
let lists: { params: ListCall; full: boolean; appended: number }[];
/** 旧引擎：不认 have，一律给完整列表。 */
let legacyEngine: boolean;
/** 给了就扣住下一次 chat.messages.list 的应答，调用它才放行。 */
let holdNext: ((release: () => void) => void) | undefined;
let clock: number;

const wire = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
function answerList(p: ListCall): unknown {
  if (legacyEngine || p.have === undefined) return engine.listMessages(p.sessionId);
  const append = engine.listMessagesAfter(p.sessionId, p.have);
  return append ? { append } : engine.listMessages(p.sessionId);
}

function stubRpc(): void {
  rpcCallMock.mockImplementation(async (method: string, params?: any) => {
    if (method === 'permission.getPreset') return { preset: 'ask' };
    if (method === 'chat.sessions.list') return [{ id: A, title: 'A' }, { id: B, title: 'B' }];
    if (method === 'provider.instances.list' || method === 'modelgroup.list' || method === 'assistants.list' || method === 'skills.list') return [];
    if (method === 'provider.getDefault') return {};
    if (method === 'control.status') return { syncPaused: false };
    if (method === 'chat.annotations.list') return { annotations: [] };
    if (method === 'workspace.get') return { root: '/w', isDefault: true };
    if (method === 'chat.prompt') return { ok: true };
    if (method === 'chat.messages.list') {
      const r = wire(answerList(params as ListCall)) as any;
      lists.push({ params: wire(params) as ListCall, full: Array.isArray(r), appended: Array.isArray(r) ? -1 : r.append.length });
      if (holdNext) { const h = holdNext; holdNext = undefined; await new Promise<void>(res => h(res)); }
      return r;
    }
    return undefined;
  });
}

const tick = (): Promise<void> => new Promise(r => setTimeout(r, 0));
const settle = async (): Promise<void> => { for (let i = 0; i < 3; i++) await tick(); };
/** 引擎里落一条消息（时间严格递增，除非指定）。 */
function persist(sessionId: string, role: 'user' | 'assistant', text: string, at?: number): string {
  const id = engine.newId();
  clock = at ?? clock + 1;
  engine.appendMessage({ id, sessionId, role, parts: [{ type: 'text', value: text }], createdAt: clock, streamInterruptCount: 0 });
  return id;
}
/** 别的设备的一条消息经同步合并进来。deliver：渲染端收不收得到那条同步通知。 */
function mergeIn(sessionId: string, id: string, at: number, deliver: boolean): void {
  const payload: SyncPayload = {
    messages: [{
      id, sessionId, role: 'user', partsJson: JSON.stringify([{ type: 'text', value: `对端 ${id}` }]),
      tokenUsageJson: null, reasoningContent: null, streamInterruptCount: 0, sortOrder: 0,
      createdAt: at, updatedAt: at, originDeviceId: 'peer', createdLocallyAt: at,
    }],
    markers: [],
  };
  expect(engine.mergeRemoteSession(payload, sessionId, { fromPeer: 'peer' })).toMatchObject({ mergedCount: 1 });
  if (deliver) handlers.get('chat.event')!({ kind: 'synced', sessionId, mergedCount: 1, fromDevice: 'peerfp' });
}
/** messages 里落库的那一段（乐观气泡的 id 以 local- 开头）。 */
const persisted = (chat: Chat): unknown[] => toRaw(chat.messages).filter(m => !m.id.startsWith('local-'));
const sameAsEngine = (chat: Chat, sessionId: string): void => {
  expect(JSON.stringify(persisted(chat))).toBe(JSON.stringify(wire(engine.listMessages(sessionId))));
};
const last = (): { params: ListCall; full: boolean; appended: number } => lists[lists.length - 1];

async function boot(): Promise<Chat> {
  stubRpc();
  const chat = useChat();
  await chat.init();
  await chat.open(A);
  await settle();
  return chat;
}

beforeEach(() => {
  rpcCallMock.mockReset();
  handlers.clear();
  setActivePinia(createPinia());
  engine = new ChatStore(openDb(':memory:'), 'local');
  A = engine.createSession('A').id;
  B = engine.createSession('B').id;
  lists = []; legacyEngine = false; holdNext = undefined; clock = 1000;
  for (let i = 0; i < 4; i++) persist(A, i % 2 ? 'assistant' : 'user', `甲 ${i}`);
  for (let i = 0; i < 2; i++) persist(B, i % 2 ? 'assistant' : 'user', `乙 ${i}`);
});

describe('Q14 什么时候带 have', () => {
  it('第一次打开一个会话不带；同一个会话再取时带上「手里有几条、最后一条是谁」', async () => {
    const chat = await boot();
    expect(lists).toEqual([{ params: { sessionId: A }, full: true, appended: -1 }]);
    const ids = engine.listMessages(A).map(m => m.id);
    await chat.open(A);
    expect(last()).toEqual({ params: { sessionId: A, have: { count: 4, lastId: ids[3] } }, full: false, appended: 0 });
    sameAsEngine(chat, A);
  });

  it('没有新消息时也换成一个新数组（界面按「数组换没换」判断历史取回来了没有）', async () => {
    const chat = await boot();
    const before = toRaw(chat.messages);
    await chat.open(A);
    expect(last().appended).toBe(0);
    expect(toRaw(chat.messages)).not.toBe(before);
    expect(toRaw(chat.messages)).toEqual(before);
  });

  it('空会话：手里 0 条也带（count 0），回来的是全部', async () => {
    const empty = engine.createSession('空').id;
    const chat = await boot();
    await chat.open(empty);
    expect(last()).toEqual({ params: { sessionId: empty }, full: true, appended: -1 });
    persist(empty, 'user', '第一句'); persist(empty, 'assistant', '第一答');
    await chat.open(empty);
    expect(last()).toEqual({ params: { sessionId: empty, have: { count: 0 } }, full: false, appended: 2 });
    sameAsEngine(chat, empty);
  });

  it('换到别的会话、再换回来：两次都不带（手里那份是另一个会话的）', async () => {
    const chat = await boot();
    await chat.open(B);
    expect(last()).toEqual({ params: { sessionId: B }, full: true, appended: -1 });
    sameAsEngine(chat, B);
    await chat.open(A);
    expect(last()).toEqual({ params: { sessionId: A }, full: true, appended: -1 });
    sameAsEngine(chat, A);
  });

  it('收到这个会话的同步通知之后不带；别的会话的同步通知不影响', async () => {
    const chat = await boot();
    mergeIn(B, 'PB', clock + 50, true);
    await chat.open(A);
    expect(last().params.have).toBeDefined();
    // 并进来的这条排在最后——引擎本来接得上；不带 have 是渲染端自己作废的
    mergeIn(A, 'PA', clock + 60, true);
    await chat.open(A);
    expect(last()).toEqual({ params: { sessionId: A }, full: true, appended: -1 });
    sameAsEngine(chat, A);
    // 取过完整列表之后又可以续取
    await chat.open(A);
    expect(last().params.have).toEqual({ count: 5, lastId: 'PA' });
  });

  it('连接断过之后不带', async () => {
    const chat = await boot();
    chat.onLinkStatus({ state: 'reconnecting', attempt: 1, maxAttempts: 8 } as never);
    chat.onLinkStatus({ state: 'open' } as never);
    await chat.open(A);
    expect(last()).toEqual({ params: { sessionId: A }, full: true, appended: -1 });
    await chat.open(A);
    expect(last().params.have).toBeDefined();
  });
});

describe('Q14 回合结束：只取这一回合落库的消息，乐观气泡被真实消息换掉', () => {
  it('发送、落库、turnEnd：have 不把气泡算进去；之后没有气泡，提问只有一条，与引擎的列表相同', async () => {
    const chat = await boot();
    const before = engine.listMessages(A).map(m => m.id);
    await chat.send('新的一问');
    const bubble = toRaw(chat.messages).at(-1)!;
    expect([bubble.role, bubble.id.startsWith('local-'), chat.messages.length]).toEqual(['user', true, 5]);
    const u = persist(A, 'user', '新的一问');
    const a = persist(A, 'assistant', '新的一答');
    handlers.get('chat.event')!({ sessionId: A, event: { kind: 'turnEnd', stopReason: 'endTurn' } });
    await settle();
    expect(last()).toEqual({ params: { sessionId: A, have: { count: 4, lastId: before[3] } }, full: false, appended: 2 });
    expect(chat.messages.map(m => m.id)).toEqual([...before, u, a]);
    expect(chat.messages.filter(m => m.role === 'user' && m.parts[0].value === '新的一问')).toHaveLength(1);
    sameAsEngine(chat, A);
  });

  it('新会话的第一个回合：手里只有气泡，带 count 0', async () => {
    const empty = engine.createSession('空').id;
    const chat = await boot();
    await chat.open(empty);
    await chat.send('头一句');
    persist(empty, 'user', '头一句'); persist(empty, 'assistant', '头一答');
    handlers.get('chat.event')!({ sessionId: empty, event: { kind: 'turnEnd' } });
    await settle();
    expect(last()).toEqual({ params: { sessionId: empty, have: { count: 0 } }, full: false, appended: 2 });
    expect(chat.messages.some(m => m.id.startsWith('local-'))).toBe(false);
    sameAsEngine(chat, empty);
  });

  it('以出错收尾同样只取增量', async () => {
    const chat = await boot();
    await chat.send('会出错的一问');
    persist(A, 'user', '会出错的一问');
    handlers.get('chat.event')!({ sessionId: A, event: { kind: 'error', message: '端点报错' } });
    await settle();
    expect(last()).toMatchObject({ full: false, appended: 1 });
    expect(chat.messages.some(m => m.id.startsWith('local-'))).toBe(false);
    sameAsEngine(chat, A);
  });
});

describe('Q14 应答怎么用', () => {
  it('同步合并进来一条时间更早的消息、通知没收到：引擎判断接不上，给完整列表，顺序正确', async () => {
    const chat = await boot();
    const before = engine.listMessages(A).map(m => m.id);
    mergeIn(A, 'EARLY', 1001.5, false); // 排在第一条（1001）与第二条（1002）之间
    await chat.open(A);
    expect(last()).toEqual({ params: { sessionId: A, have: { count: 4, lastId: before[3] } }, full: true, appended: -1 });
    expect(chat.messages.map(m => m.id)).toEqual([before[0], 'EARLY', before[1], before[2], before[3]]);
    sameAsEngine(chat, A);
  });

  it('同步合并进来一条时间更早的消息、通知收到了：不带 have，完整列表，顺序正确', async () => {
    const chat = await boot();
    const before = engine.listMessages(A).map(m => m.id);
    mergeIn(A, 'EARLY', 1001.5, true);
    await chat.open(A);
    expect(last()).toEqual({ params: { sessionId: A }, full: true, appended: -1 });
    expect(chat.messages.map(m => m.id)).toEqual([before[0], 'EARLY', before[1], before[2], before[3]]);
  });

  it('旧引擎不认 have、照旧给完整列表：整体替换，不会把完整列表当成增量接在后面', async () => {
    const chat = await boot();
    legacyEngine = true;
    persist(A, 'user', '再问'); persist(A, 'assistant', '再答');
    await chat.open(A);
    expect(last()).toMatchObject({ full: true });
    expect(last().params.have).toBeDefined();
    expect(chat.messages).toHaveLength(6);
    sameAsEngine(chat, A);
  });

  it('「手里有什么」在发请求那一刻取定：应答回来之前 messages 被换掉，结果仍是完整的列表', async () => {
    const chat = await boot();
    let release: () => void = () => undefined;
    holdNext = r => { release = r; };
    const opening = chat.open(A);
    await tick();
    chat.messages = [];                 // 应答在途时别处把历史换掉了
    persist(A, 'user', '在途期间落的'); // 引擎在应答之后才落的消息，这次看不到
    release();
    await opening;
    expect(chat.messages).toHaveLength(4);
    await chat.open(A);
    expect(last()).toMatchObject({ full: false, appended: 1 });
    sameAsEngine(chat, A);
  });

  it('尾巴模式：一条消息落库的事件只取那之后的消息，仍在核对中的气泡留在末尾', async () => {
    const chat = await boot();
    chat.running = true; chat.joinedTail = true; chat.streamingText = '已落库的一段';
    const m = persist(A, 'assistant', '已落库的一段');
    handlers.get('chat.event')!({ sessionId: A, event: { kind: 'messagePersisted', messageId: m } });
    await settle();
    expect(last()).toMatchObject({ full: false, appended: 1 });
    expect(chat.messages.at(-1)!.id).toBe(m);
    expect(chat.streamingText).toBe('');
    sameAsEngine(chat, A);
    // 再落一条：从上一次的结果接着取
    const n = persist(A, 'user', '工具结果');
    handlers.get('chat.event')!({ sessionId: A, event: { kind: 'messagePersisted', messageId: n } });
    await settle();
    expect(last()).toEqual({ params: { sessionId: A, have: { count: 5, lastId: m } }, full: false, appended: 1 });
    sameAsEngine(chat, A);
  });

  it('尾巴模式中途收到同步通知：下一次取完整列表，再下一次又只取增量', async () => {
    const chat = await boot();
    chat.running = true; chat.joinedTail = true;
    mergeIn(A, 'PEER', clock + 0.5, true);
    const m = persist(A, 'assistant', '第一条');
    handlers.get('chat.event')!({ sessionId: A, event: { kind: 'messagePersisted', messageId: m } });
    await settle();
    expect(last()).toEqual({ params: { sessionId: A }, full: true, appended: -1 });
    const n = persist(A, 'user', '第二条');
    handlers.get('chat.event')!({ sessionId: A, event: { kind: 'messagePersisted', messageId: n } });
    await settle();
    expect(last()).toEqual({ params: { sessionId: A, have: { count: 6, lastId: m } }, full: false, appended: 1 });
    sameAsEngine(chat, A);
  });

  it('界面重新初始化（新的 store）之后第一次打开不带 have，哪怕打开的是上一份 store 最后看的那个会话', async () => {
    const first = await boot();
    await first.open(A);
    expect(last().params.have).toBeDefined();
    setActivePinia(createPinia());
    const second = useChat();
    await second.init();
    await second.open(A);
    expect(last()).toEqual({ params: { sessionId: A }, full: true, appended: -1 });
    sameAsEngine(second, A);
  });
});

describe('Q14 随机序列', () => {
  const rng = (seed: number) => () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
  /** 去掉 sortOrder 再比：同步通知没收到时，手里旧消息的 sortOrder 可能是合并之前的值（界面不读它）。 */
  const loose = (ms: unknown[]): string => JSON.stringify(ms.map(m => ({ ...(m as object), sortOrder: 0 })));

  it('300 步：回合收尾、尾巴重取、同步合并（更早 / 更晚 / 同一时刻，通知收到或丢失）、重开、换会话——每次取完历史都与引擎的完整列表相同', async () => {
    const chat = await boot();
    const rand = rng(0x1407);
    let cur = A, n = 0, incremental = 0, fullAfterHave = 0, plain = 0, staleSort = 0;
    /** 上一次取完整列表之后，有没有哪条同步通知没送到。 */
    let missedNotice = false;
    for (let step = 0; step < 300; step++) {
      const mark = lists.length;
      const pick = rand();
      const here = engine.listMessages(cur);
      if (pick < 0.3) {
        // 一个回合：气泡、落 1 到 3 条、收尾
        chat.joinedTail = false;
        await chat.send(`问 ${step}`);
        persist(cur, 'user', `问 ${step}`);
        for (let k = Math.floor(rand() * 3); k > 0; k--) persist(cur, 'assistant', `答 ${step}-${k}`);
        handlers.get('chat.event')!({ sessionId: cur, event: { kind: rand() < 0.8 ? 'turnEnd' : 'error', message: 'x' } });
      } else if (pick < 0.45) {
        chat.running = true; chat.joinedTail = true;
        const m = persist(cur, 'assistant', `尾巴 ${step}`);
        handlers.get('chat.event')!({ sessionId: cur, event: { kind: 'messagePersisted', messageId: m } });
        await settle();
        chat.running = false; chat.joinedTail = false;
      } else if (pick < 0.75) {
        const deliver = rand() < 0.5;
        const where = rand();
        const first = here[0]?.createdAt ?? clock, lastAt = here.at(-1)?.createdAt ?? clock;
        const at = where < 0.4 ? first - 1 + rand() * (lastAt - first + 1)          // 中间某处（可能比第一条还早）
          : where < 0.7 ? lastAt + 0.25                                              // 排在最后
          : here[Math.floor(rand() * here.length)]?.createdAt ?? clock;              // 与某条同一时刻
        mergeIn(cur, `P${String(n++).padStart(4, '0')}`, at, deliver);
        if (!deliver) missedNotice = true;
        await chat.open(cur);
      } else if (pick < 0.9) {
        await chat.open(cur);
      } else {
        cur = cur === A ? B : A;
        await chat.open(cur);
      }
      await settle();
      for (const c of lists.slice(mark)) {
        if (c.params.have === undefined) { plain++; missedNotice = false; }
        else if (c.full) { fullAfterHave++; missedNotice = false; }
        else incremental++;
      }
      const want = wire(engine.listMessages(cur));
      const got = persisted(chat);
      expect(loose(got), `第 ${step} 步`).toBe(loose(want));
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        staleSort++;
        // 只有「通知丢了」才允许 sortOrder 对不上
        expect(missedNotice, `第 ${step} 步：sortOrder 不同而同步通知都送到了`).toBe(true);
      }
      expect(chat.messages.filter(m => m.id.startsWith('local-')).length, `第 ${step} 步`).toBeLessThanOrEqual(1);
    }
    // 三条路都走到过足够多次
    expect(incremental).toBeGreaterThan(80);
    expect(fullAfterHave).toBeGreaterThan(10);
    expect(plain).toBeGreaterThan(20);
    // 这份种子下通知丢了也没有出现过 sortOrder 对不上（上面留着那条判断是防种子或步骤改了之后出现）
    expect(staleSort).toBe(0);
  });
});
