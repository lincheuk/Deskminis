/**
 * W2b-3 · 断线横幅与「断线后不能发送」（止血设计稿 §3 第 7 条、§2「渲染端」「生命周期」；
 * 侦察 renderer.md「W2b-disconnect」；cross.md S20）。
 *
 * 旧实现：minisd 在握手之后崩了（或被杀、端口被关），渲染端对 ws 断开没有任何处理——
 * 停止键一直亮着、权限卡留着一排点了没反应的按钮、发送照样能按，界面对此一字不提。
 *
 * 本文件钉：
 *  - store 行为：init() 先订阅 rpc.onLost 再 connect（首次连接就失败时，断线通知在 connect 的 await 期间就到）；
 *    断线后 connection 为 'lost'，运行态、运行集合、权限卡、重试提示、思考缓冲清掉，正文与消息留着给用户复制；
 *    实时区的步骤卡清掉（它标着「正在执行…」，引擎已经没了）；中途接上的回合（midRun）连半截正文一起丢，
 *    与 turnEnd / error 同一口径；不写 lastError（顶栏横幅已经在说，会话页红条再说一遍就是同一句话说两遍）；
 *    同步点回到「未连接其它设备」，sync.dirty 的 2 秒回落定时器撤掉（xvfb 实拍逮到：不撤的话它到点翻成绿点
 *    「已连接其它设备」，正压在断线横幅上）。
 *  - 断线之后再发（审查补）：发送键置灰管不到键盘——Enter 照样进 chat.send，事件条的「重试」（retryLast）也走它。
 *    chat.send 开头会清流式缓冲与事件条、推乐观消息、登记运行集合；断线之后这些一样都不许动，只交代一句「连接已断开」。
 *  - relaunchApp：桥在就调它一次；桥不在、或调用失败，都给一句「请手动退出并重新打开」，不留未处理的拒绝。
 *  - 源码守卫（先剥注释再认调用形态）：TopBar 横幅在标题栏之外、紧随其后的独立一行（标题栏右侧 146px 被系统
 *    min/max/close 盖着，塞不进去），不设 z-index；Composer 的 canSend 带断线条件；rpc.ts 在 connect 里挂 onclose。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseSfc } from 'vue/compiler-sfc';
import { sfcBlocks } from './sfc-blocks';
import { stripComments } from './strip-comments';

// ── 桩掉 renderer 的 rpc：on 收处理器，onLost 收断线订阅，connect 可换成「首次就连不上」，order 记先后 ──
const { rpcCallMock, handlers, lost, order, connectImpl } = vi.hoisted(() => ({
  rpcCallMock: vi.fn(),
  handlers: new Map<string, (p: any) => void>(),
  lost: { h: undefined as undefined | ((reason: string) => void) },
  order: [] as string[],
  connectImpl: { fn: async (): Promise<void> => {} },
}));

vi.mock('../src/renderer/src/rpc', () => ({
  rpc: {
    call: rpcCallMock,
    connect: async () => { order.push('connect'); await connectImpl.fn(); },
    on: (method: string, h: (p: any) => void) => { handlers.set(method, h); },
    onLost: (h: (reason: string) => void) => { order.push('onLost'); lost.h = h; },
  },
}));

// eslint-disable-next-line import/first —— vi.mock 由 vitest 提升到顶部，此处 import 拿到的是桩
import { createPinia, setActivePinia } from 'pinia';
// eslint-disable-next-line import/first
import { useChat } from '../src/renderer/src/stores/chat';

const root = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');
const LOST = '与后台服务的连接已断开';

function stubRpc(): void {
  rpcCallMock.mockImplementation(async (method: string) => {
    if (method === 'permission.getPreset') return { preset: 'ask' };
    if (method === 'chat.sessions.list') return [{ id: 'A', title: 'A' }, { id: 'B', title: 'B' }];
    if (method === 'provider.instances.list') return [];
    if (method === 'provider.getDefault') return {};
    if (method === 'modelgroup.list') return [];
    if (method === 'assistants.list') return [];
    if (method === 'skills.list') return [];
    if (method === 'control.status') return { syncPaused: false };
    if (method === 'chat.messages.list') return [{ id: 'u1', role: 'user', parts: [{ type: 'text', value: '帮我抓个网页' }], createdAt: 1 }];
    if (method === 'chat.annotations.list') return { annotations: [] };
    if (method === 'workspace.get') return { root: '/w', isDefault: true };
    return undefined;
  });
}

async function boot(active = 'A') {
  stubRpc();
  const chat = useChat();
  await chat.init();
  await chat.open(active);
  return chat;
}

function fireLost(): void {
  if (!lost.h) throw new Error('init() 没有订阅 rpc.onLost');
  lost.h(LOST);
}

const g = globalThis as any;
let savedWindow: unknown;
beforeEach(() => {
  rpcCallMock.mockReset();
  handlers.clear();
  lost.h = undefined;
  order.length = 0;
  connectImpl.fn = async () => {};
  savedWindow = g.window;
  setActivePinia(createPinia());
});
afterEach(() => { g.window = savedWindow; });

describe('W2b-3 store：断线订阅挂在 connect 之前', () => {
  it('init() 先 rpc.onLost(…) 再 rpc.connect()', async () => {
    await boot();
    expect(order.slice(0, 2)).toEqual(['onLost', 'connect']);
  });

  it('首次连接就连不上：connect 抛错之前断线通知已到，init 照样报错，但 connection 已是 lost——横幅在首启失败时也出现', async () => {
    stubRpc();
    // 浏览器连不上时先 error 后 close：close 触发的断线通知落在 connect 的 await 期间
    connectImpl.fn = async () => { lost.h?.(LOST); throw new Error('WebSocket 连接失败'); };
    const chat = useChat();
    await expect(chat.init()).rejects.toThrow('WebSocket 连接失败');
    expect(chat.connection).toBe('lost');
  });
});

describe('W2b-3 store：断线后清掉「在跑」与没人接收的卡，留下能复制的正文', () => {
  it('connection 变 lost；running、runningSessions、pendingPerms、retryNote、streamingThinking 清掉；正文与消息留着；不写 lastError', async () => {
    const chat = await boot('A');
    expect(chat.connection).toBe('ok');
    chat.running = true;
    chat.runningSessions = ['A', 'B'];
    chat.pendingPerms = [{ requestId: 'R1', sessionId: 'A', detail: 'http://x', kind: 'web-fetch', toolTitle: '抓取' }];
    chat.retryNote = '正在重试…（第 1 次，2s 后）';
    chat.streamingThinking = '想一半';
    chat.streamingText = '答了一半的正文';
    chat.toolCards = [{ toolUseId: 't1', name: 'web_fetch', title: '抓取', startedAt: 1 }];
    const messagesBefore = chat.messages.length;
    expect(messagesBefore).toBeGreaterThan(0);

    fireLost();

    expect(chat.connection).toBe('lost');
    expect(chat.running).toBe(false);
    expect(chat.runningSessions).toEqual([]);
    expect(chat.pendingPerms).toEqual([]);
    expect(chat.retryNote).toBe('');
    expect(chat.streamingThinking).toBe('');
    // 半截回复留给用户复制
    expect(chat.streamingText).toBe('答了一半的正文');
    expect(chat.messages).toHaveLength(messagesBefore);
    // 实时区的步骤组标着「正在执行…」：引擎已经没了，留着就是假话
    expect(chat.toolCards).toEqual([]);
    // 顶栏横幅已经在说，会话页红条不再说第二遍
    expect(chat.lastError).toBe('');
  });

  it('同步点回到「未连接其它设备」，sync.dirty 留下的 2 秒回落定时器也撤掉（不然到点翻成绿的「已连接其它设备」，正压在断线横幅上）', async () => {
    const chat = await boot('A');
    vi.useFakeTimers();
    try {
      const dirty = handlers.get('sync.dirty');
      if (!dirty) throw new Error('init() 没有订阅 sync.dirty');
      dirty({});
      expect(chat.syncState).toBe('syncing');
      fireLost();
      expect(chat.syncState).toBe('offline');
      vi.advanceTimersByTime(2500);
      expect(chat.syncState).toBe('offline');
    } finally {
      vi.useRealTimers();
    }
  });

  it('中途接上的回合（midRun）断线：占位撤下，半截正文与步骤卡一起丢（与 turnEnd / error 同一口径）', async () => {
    const chat = await boot('A');
    chat.running = true;
    chat.midRun = true;
    chat.runningSessions = ['A'];
    chat.streamingText = '从句子中间接上的';
    chat.toolCards = [{ toolUseId: 't1', name: 'web_fetch', title: '抓取', startedAt: 1 }];

    fireLost();

    expect(chat.midRun).toBe(false);
    expect(chat.running).toBe(false);
    expect(chat.streamingText).toBe('');
    expect(chat.toolCards).toEqual([]);
  });
});

describe('W2b-3 store：断线之后再发（Enter 硬发、事件条「重试」）不许清掉留给用户复制的正文', () => {
  const HALF = '答了一半、引擎就崩了的正文';
  type Note = ReturnType<typeof useChat>['eventNotes'][number];

  /** 回合正在出字时断线；之后真 rpc 的每个 call 都立即以 LOST 拒绝（rpc.ts sendNow 第一句），桩照此改。 */
  async function lostMidReply(notes: Note[]) {
    const chat = await boot('A');
    chat.running = true;
    chat.runningSessions = ['A'];
    chat.streamingText = HALF;
    chat.eventNotes = notes;
    fireLost();
    rpcCallMock.mockReset();
    rpcCallMock.mockImplementation(async () => { throw new Error(LOST); });
    expect(chat.streamingText).toBe(HALF);
    expect(chat.eventNotes).toEqual(notes);
    return chat;
  }
  const idsOf = (chat: ReturnType<typeof useChat>): string[] => chat.messages.map(m => m.id);

  // 每条都用 soft：先红时一次列出全部被破坏的项，而不是停在第一条
  it('Enter 硬发（Composer.send → chat.send）：正文、事件条、消息原样；不推乐观消息、不登记运行；lastError 交代「连接已断开」', async () => {
    const note: Note = { kind: 'fallback', ts: 1, detail: 'mock-a → mock-b（限流）' };
    const chat = await lostMidReply([note]);
    expect(idsOf(chat)).toEqual(['u1']);

    const sending = chat.send('断线之后还想接着问');
    // 同步段：发不出去的消息不许先落一个「已发送」气泡、不许让停止键亮起来
    expect.soft(idsOf(chat), '断线后不许推乐观消息').toEqual(['u1']);
    expect.soft(chat.running, '断线后不许登记「在跑」').toBe(false);
    expect.soft(chat.runningSessions, '断线后不许登记运行集合').toEqual([]);
    await sending;

    expect.soft(chat.streamingText, '断线时留给用户复制的半截回复被一次 Enter 清掉了').toBe(HALF);
    expect.soft(chat.eventNotes, '事件条被清掉了').toEqual([note]);
    expect.soft(idsOf(chat)).toEqual(['u1']);
    expect.soft(chat.running).toBe(false);
    expect.soft(chat.runningSessions).toEqual([]);
    // 输入卡见 lastError 才把寄存的草稿交回框里（Composer send 之后那行 takeDraft）
    expect.soft(chat.lastError).toContain('断开');
  });

  it('事件条「重试」（retryLast → send）：同样原样保留正文与事件条（重试钮所在的那条错误也在）', async () => {
    const note: Note = { kind: 'error', ts: 1, detail: '上游 502', retryable: true };
    const chat = await lostMidReply([note]);

    await chat.retryLast();

    expect.soft(chat.streamingText, '断线时留给用户复制的半截回复被「重试」清掉了').toBe(HALF);
    expect.soft(chat.eventNotes, '事件条（连同带重试钮的那条错误）被清掉了').toEqual([note]);
    expect.soft(idsOf(chat)).toEqual(['u1']);
    expect.soft(chat.running).toBe(false);
    expect.soft(chat.runningSessions).toEqual([]);
    expect.soft(chat.lastError).toContain('断开');
  });
});

describe('W2b-3 store：relaunchApp 走桥，走不通就说清楚', () => {
  it('桥上有 relaunchApp：调它恰好一次，不写 lastError', async () => {
    const chat = await boot();
    const relaunch = vi.fn(async () => {});
    g.window = { deskminis: { relaunchApp: relaunch } };
    await chat.relaunchApp();
    expect(relaunch).toHaveBeenCalledTimes(1);
    expect(chat.lastError).toBe('');
  });

  it('桥上没有 relaunchApp（旧 preload / 浏览器里开发）：lastError 说「请手动退出并重新打开」', async () => {
    const chat = await boot();
    g.window = { deskminis: {} };
    await chat.relaunchApp();
    expect(chat.lastError).toContain('手动');
  });

  it('桥调用失败（主进程拒绝）：不抛出（横幅的按钮不接 catch），lastError 同样给出路', async () => {
    const chat = await boot();
    g.window = { deskminis: { relaunchApp: async () => { throw new Error('只接受主窗口的重启请求'); } } };
    await expect(chat.relaunchApp()).resolves.toBeUndefined();
    expect(chat.lastError).toContain('手动');
    expect(chat.lastError).toContain('只接受主窗口的重启请求');
  });
});

// ── 源码守卫：先剥注释（模板剥 <!-- -->、样式剥 /* */、脚本剥 /* */ 与 // 行）再认调用形态 ──

describe('W2b-3 TopBar：标题栏下方独立一行的断线横幅', () => {
  const src = read('src/renderer/src/ui/TopBar.vue');
  const { template, style } = sfcBlocks(src, 'TopBar.vue');
  // 结构用模板语法树判：横幅必须是模板根上、紧跟 <header> 的兄弟，而不是塞进 header（那一行右侧被系统按钮盖着）
  const ast = parseSfc(src, { filename: 'TopBar.vue' }).descriptor.template!.ast!;
  const rootEls = ast.children.filter((n: any) => n.type === 1) as any[];
  const vIfOf = (el: any): string | undefined => el.props.find((p: any) => p.type === 7 && p.name === 'if')?.exp?.content;

  it('模板根上：先是 <header>，紧随其后的兄弟元素 v-if="chat.connection === \'lost\'"', () => {
    const iHeader = rootEls.findIndex(el => el.tag === 'header');
    expect(iHeader, '模板根上找不到 <header>').toBeGreaterThan(-1);
    const next = rootEls[iHeader + 1];
    expect(next, '<header> 后面没有兄弟元素').toBeTruthy();
    expect(vIfOf(next)).toBe("chat.connection === 'lost'");
    expect(template).toMatch(/<div v-if="chat\.connection === 'lost'"[^>]*\bclass="lost"/);
    expect(template).toMatch(/<div v-if="chat\.connection === 'lost'"[^>]*\brole="alert"/);
  });

  it('横幅里：alert 图标、文案「与后台服务的连接已断开。进行中的任务可能已中止，新的操作不会执行。」、「重启应用」按钮调 chat.relaunchApp()', () => {
    const at = template.search(/<div v-if="chat\.connection === 'lost'"/);
    const banner = template.slice(at, template.indexOf('</div>', at));
    expect(banner).toMatch(/<UiIcon name="alert"/);
    expect(banner).toContain('与后台服务的连接已断开。进行中的任务可能已中止，新的操作不会执行。');
    expect(banner).toMatch(/<button class="f-btn primary" type="button" @click="chat\.relaunchApp\(\)">重启应用<\/button>/);
  });

  it('.lost 走正常流：不写 z-index（标题栏层级守卫的槽位在 50）、不写 position；底色 --c-err-soft、字色 --c-err', () => {
    const m = /(^|\})\s*\.lost\s*\{([^}]*)\}/.exec(style);
    expect(m, '找不到 .lost 规则块').not.toBeNull();
    const body = m![2];
    expect(body).not.toMatch(/z-index/);
    expect(body).not.toMatch(/position\s*:/);
    expect(body).toMatch(/background:\s*var\(--c-err-soft\)/);
    expect(body).toMatch(/(^|[^-])color:\s*var\(--c-err\)/);
  });
});

describe('W2b-3 Composer：断线后不能发送', () => {
  it('canSend 带断线条件，插在尾锚 `&& !chat.running && !sending.value)` 之前', () => {
    const { script } = sfcBlocks(read('src/renderer/src/ui/Composer.vue'), 'Composer.vue');
    expect(script).toMatch(/const canSend = computed\(\(\) =>[^;]*&& chat\.connection !== 'lost' && !chat\.running && !sending\.value\);/);
  });
});

describe('W2b-3 store 与 rpc 的接线（源码）', () => {
  const store = stripComments(read('src/renderer/src/stores/chat.ts'));
  const rpcSrc = stripComments(read('src/renderer/src/rpc.ts'));

  it('store：init() 里 rpc.onLost(() => this.markConnectionLost()) 写在 await rpc.connect() 之前', () => {
    const init = store.slice(store.indexOf('async init() {'));
    const iLost = init.search(/rpc\.onLost\(\(\) => this\.markConnectionLost\(\)\);/);
    const iConnect = init.indexOf('await rpc.connect();');
    expect(iLost, '找不到 rpc.onLost(() => this.markConnectionLost());').toBeGreaterThan(-1);
    expect(iConnect).toBeGreaterThan(iLost);
  });

  it('rpc.ts：connect 里紧跟 new WebSocket(url) 挂 this.ws.onclose = …，sendNow 第一句判断线', () => {
    expect(rpcSrc).toMatch(/this\.ws = new WebSocket\(url\);[\s\S]{0,400}?this\.ws\.onclose = /);
    expect(rpcSrc).toMatch(/const sendNow = \(\): Promise<T> => \{\s*if \(this\.lost\) return Promise\.reject\(new Error\(LOST\)\);/);
  });
});
