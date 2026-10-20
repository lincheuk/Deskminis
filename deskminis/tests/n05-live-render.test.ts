/** N05：真实 store 的流式显示快照与 StageChat 的双帧贴底，手动推进绘制边界。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, isVNode, nextTick, watchEffect, type Ref, type VNode } from 'vue';
import { join } from 'node:path';
import { runSetup, type SetupRun } from './sfc-setup';
import { deferred, initStore, minimalReply, resetStoreRpc, type Chat } from './renderer-store-fixture';

const probe = vi.hoisted(() => ({
  call: vi.fn(), on: vi.fn(), handlers: new Map<string, (p: any) => unknown>(),
  lost: vi.fn(), connect: vi.fn(), parse: vi.fn(),
}));
vi.mock('../src/renderer/src/rpc', () => ({ rpc: {
  call: probe.call, connect: probe.connect, onLost: probe.lost,
  on: (method: string, handler: (p: any) => unknown) => { probe.on(method, handler); probe.handlers.set(method, handler); },
} }));
vi.mock('../src/renderer/src/lib/markdown/parse', async importOriginal => {
  const real = await importOriginal<typeof import('../src/renderer/src/lib/markdown/parse')>();
  return { ...real,
    parseMarkdown: (text: string) => { probe.parse(text); return real.parseMarkdown(text); },
    parseLiveMarkdown: (text: string) => { probe.parse(text); return real.parseLiveMarkdown(text); },
  };
});

const UI = join(__dirname, '../src/renderer/src/ui');
type Render = (ctx: object, cache: unknown[]) => VNode;
const frames = new Map<number, FrameRequestCallback>();
let frameId = 0;
let chat: Chat;
const mounted: SetupRun<any>[] = [];

function all(value: unknown): VNode[] {
  if (Array.isArray(value)) return value.flatMap(all);
  return isVNode(value) ? [value, ...all(value.children)] : [];
}
function component(tree: VNode, name: string): VNode | undefined {
  return all(tree).find(n => typeof n.type === 'object' && 'name' in n.type && String(n.type.name).endsWith(name));
}
async function frame(): Promise<void> {
  const jobs = [...frames.values()];
  frames.clear();
  for (const job of jobs) job(16);
  await nextTick();
}
async function live() {
  const emit = vi.fn(), scope = effectScope();
  const run = await runSetup<Render>(join(UI, 'LiveTurn.vue'), {}, scope, { inlineTemplate: true, emit });
  mounted.push(run);
  let tree!: VNode;
  const cache: unknown[] = [];
  scope.run(() => watchEffect(() => { tree = run.bindings({}, cache); }));
  run.mount();
  return {
    run, emit,
    thinkingVisible: () => !!component(tree, 'ThinkBlock.vue'),
    shown: () => ({
      nodes: component(tree, 'MarkdownView.vue')?.props?.nodes ?? null,
      thinking: component(tree, 'ThinkBlock.vue')?.props?.text ?? '',
    }),
  };
}
function delta(text: string, thinking = ''): void {
  chat.onEvent({ kind: 'textDelta', text });
  if (thinking) chat.onEvent({ kind: 'thinkingDelta', text: thinking });
}

beforeEach(async () => {
  resetStoreRpc(probe);
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
  probe.parse.mockClear();
  frames.clear();
  frameId = 0; // 0 也是合法的 rAF ID，不能用真假判断有无排队。
  vi.stubGlobal('requestAnimationFrame', vi.fn((cb: FrameRequestCallback) => { const id = frameId++; frames.set(id, cb); return id; }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => { frames.delete(id); }));
  chat = await initStore(probe);
  chat.activeId = 'S';
  chat.running = true;
  chat.runningSessions = ['S'];
  chat.runOf.S = { runId: 'R1', generation: 1, ended: false };
});

afterEach(() => {
  for (const run of mounted.splice(0)) run.unmount();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('N05 LiveTurn 每帧显示与同步边界', () => {

  it('同一帧 N 个任务只解析、通知一次，正文与思考逐字对齐', async () => {
    const view = await live();
    for (const part of ['中文', ' **bold**', ' 🙂', '\n\n收尾']) {
      delta(part, '思' + part);
      await nextTick(); // 模拟各个消息任务之间 Vue 都有机会刷新。
      expect(probe.parse).not.toHaveBeenCalled();
      expect(view.emit).not.toHaveBeenCalled();
      expect(view.shown()).toEqual({ nodes: null, thinking: '' });
      expect(view.thinkingVisible()).toBe(false);
    }
    expect(frames.size).toBe(1);
    await frame();
    expect(probe.parse.mock.calls).toEqual([[chat.streamingText]]);
    const real = await vi.importActual<typeof import('../src/renderer/src/lib/markdown/parse')>('../src/renderer/src/lib/markdown/parse');
    expect(view.shown().nodes).toEqual(real.parseMarkdown(chat.streamingText));
    expect(view.shown().thinking).toBe(chat.streamingThinking);
    expect(view.thinkingVisible()).toBe(true);
    expect(view.emit.mock.calls).toEqual([['content']]);

    const firstThinking = view.shown().thinking;
    delta('最后一段', '最后思考');
    await nextTick();
    expect(probe.parse).toHaveBeenCalledTimes(1);
    expect(view.shown().thinking).toBe(firstThinking);
    await frame();
    expect(probe.parse.mock.calls.at(-1)).toEqual([chat.streamingText]);
    expect(view.shown().thinking).toBe(chat.streamingThinking);
    expect(view.emit).toHaveBeenCalledTimes(2);
  });

  it.each(['running=false', 'turnEnd', 'error', 'cancel'] as const)('%s 不等帧就显示最终快照', async end => {
    const view = await live();
    delta('最后正文', '待结束思考');
    await nextTick();
    expect(probe.parse).not.toHaveBeenCalled();
    // open 的应答闸：明确观察终态同步收口，而非异步历史刷新后的偶然一致。
    const history = deferred();
    probe.call.mockImplementation((method: string) => method === 'chat.messages.list' ? history.promise : minimalReply(method));
    if (end === 'running=false') chat.running = false;
    else if (end === 'cancel') {
      await chat.cancel();
      expect(probe.call).toHaveBeenCalledWith('chat.cancel', { sessionId: 'S', runId: 'R1' });
      chat.onEvent({ kind: 'turnEnd', stopReason: 'cancelled' });
    } else chat.onEvent(end === 'error' ? { kind: 'error', code: 'cancelled', message: '合成错误' } : { kind: 'turnEnd' });
    expect(frames.size).toBe(0);
    await nextTick();
    expect(probe.parse.mock.calls.at(-1)).toEqual([chat.streamingText]);
    expect(view.shown().thinking).toBe(chat.streamingThinking);
    const calls = view.emit.mock.calls.length;
    await frame();
    expect(view.emit).toHaveBeenCalledTimes(calls);
    history.resolve([]);
    await nextTick();
  });

  it.each(['retry', 'fallback'] as const)('%s 清掉已经显示和未显示的旧尾巴', async kind => {
    const view = await live();
    delta('旧正文', '旧思考');
    await frame();
    delta('未绘制尾巴', '未绘制思考');
    chat.onEvent(kind === 'retry' ? { kind, attempt: 2, delayMs: 0 } : { kind, from: 'a', to: 'b', reason: 'fixture' });
    expect(frames.size).toBe(0);
    await nextTick();
    expect(view.shown()).toEqual({ nodes: null, thinking: '' });
    delta('新正文', '新思考');
    await frame();
    expect(probe.parse.mock.calls.at(-1)).toEqual(['新正文']);
    expect(view.shown().thinking).toBe('新思考');
  });

  it('替换文本、切会话、新运行与恢复尾巴同步换掉快照', async () => {
    const view = await live();
    delta('旧正文', '旧思考');
    await frame();
    delta('待绘制');
    chat.streamingText = '恢复后的正文';
    chat.streamingThinking = '恢复后的思考';
    expect(frames.size).toBe(0);
    await nextTick();
    expect(probe.parse.mock.calls.at(-1)).toEqual(['恢复后的正文']);
    expect(view.shown().thinking).toBe('恢复后的思考');

    for (const change of [
      () => { chat.activeId = 'B'; },
      () => { chat.runOf.B = { runId: 'R2', generation: 2, ended: false }; },
      () => { chat.runOf.B.runId = 'R3'; },
      () => { chat.runOf.B.generation++; },
      () => { chat.engineEpoch++; },
      () => { chat.joinedTail = true; },
      () => { chat.midRun = true; chat.midRun = false; },
    ]) {
      delta('边界前新尾巴', '新想法');
      await nextTick();
      const count = view.emit.mock.calls.length;
      change();
      expect(frames.size).toBe(0);
      expect(view.emit).toHaveBeenCalledTimes(count + 1);
      await nextTick();
      expect(probe.parse.mock.calls.at(-1)).toEqual([chat.streamingText]);
      expect(view.shown().thinking).toBe(chat.streamingThinking);
    }
  });

  it.each([['text', ''], ['text', '恢复正文'], ['thinking', ''], ['thinking', '恢复思考']] as const)('单字段 %s 重置为 %s 也同步取消旧帧', async (field, replacement) => {
    const view = await live();
    delta('旧正文', '旧思考');
    await frame();
    delta('待显示尾巴', '待显示思考');
    if (field === 'text') chat.streamingText = replacement;
    else chat.streamingThinking = replacement;
    expect(frames.size).toBe(0);
    await nextTick();
    expect(view.shown().thinking).toBe(chat.streamingThinking);
    if (chat.streamingText) expect(probe.parse.mock.calls.at(-1)).toEqual([chat.streamingText]);
    else expect(view.shown().nodes).toBeNull();
    const count = view.emit.mock.calls.length;
    await frame();
    expect(view.emit).toHaveBeenCalledTimes(count);
  });

  it('相同快照的运行边界不重复通知', async () => {
    const view = await live();
    delta('完整正文', '完整思考');
    await frame();
    view.emit.mockClear();
    chat.runOf.S = { runId: 'R2', generation: 2, ended: false };
    chat.running = false;
    chat.engineEpoch++;
    await nextTick();
    expect(view.emit).not.toHaveBeenCalled();
    expect(probe.parse).toHaveBeenCalledTimes(1);
  });

  it('卸载取消排队帧，之后不解析、不通知', async () => {
    const view = await live();
    delta('卸载前未绘制', '未绘制思考');
    expect(frames.size).toBe(1);
    view.run.unmount();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(0);
    expect(frames.size).toBe(0);
    await frame();
    expect(probe.parse).not.toHaveBeenCalled();
    expect(view.emit).not.toHaveBeenCalled();
    mounted.splice(mounted.indexOf(view.run), 1);
  });
});

async function stage() {
  chat.messages = [0, 1, 2].map(i => ({ id: 'U' + i, role: 'user' as const, parts: [{ type: 'text', value: '问题' + i }], createdAt: i }));
  const run = await runSetup<Render>(join(UI, 'StageChat.vue'), { narrow: false }, effectScope(), { inlineTemplate: true });
  mounted.push(run);
  const tree = run.bindings({}, []);
  const scroll = all(tree).find(n => n.props?.class === 'scroll')!;
  const writes: number[] = [];
  let top = 900;
  const element = {
    scrollHeight: 1000, clientHeight: 100,
    get scrollTop() { return top; }, set scrollTop(value: number) { writes.push(value); top = value; },
    querySelector: vi.fn(() => ({ scrollIntoView: vi.fn() })),
  };
  ((scroll.ref as { r: Ref<unknown> }).r).value = element;
  const content = () => component(tree, 'LiveTurn.vue')!.props!.onContent();
  const position = (value: number) => { scroll.props!.onWheelPassive({ deltaY: value < top ? -1 : 1 }); top = value; scroll.props!.onScroll(); };
  const jump = () => all(tree).find(n => n.type === 'button' && n.props?.class === 'tdot')!.props!.onClick();
  return { writes, element, content, position, jump };
}

describe('N05 StageChat 贴底排队', () => {

  it('N 次 content 共用一次双帧排队，执行后可再排', async () => {
    const view = await stage();
    for (let i = 0; i < 8; i++) view.content();
    await nextTick();
    expect(frames.size).toBe(1);
    view.content();
    await frame();
    expect(frames.size).toBe(1);
    expect(view.writes).toEqual([]);
    view.content();
    view.element.scrollHeight = 1400;
    await frame();
    expect(view.writes).toEqual([1400]);
    expect(frames.size).toBe(0);
    view.content();
    await nextTick(); await frame(); await frame();
    expect(view.writes).toEqual([1400, 1400]);
  });

  it('排队后用户上翻不滚，跳过后仍可重新排队', async () => {
    const view = await stage();
    view.content();
    await nextTick(); await frame();
    view.position(0);
    await frame();
    expect(view.writes).toEqual([]);
    view.content();
    await nextTick();
    expect(frames.size).toBe(0);
    view.position(900);
    view.content();
    await nextTick(); await frame(); await frame();
    expect(view.writes).toEqual([1000]);
  });

  it('导航跳转期间不滚，跳过后清标记可再次跟随', async () => {
    vi.useFakeTimers();
    const view = await stage();
    view.content();
    await nextTick(); await frame();
    view.jump();
    expect(view.element.querySelector).toHaveBeenCalledWith('[data-turn-id="U0"]');
    await frame();
    expect(view.writes).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    view.content();
    await nextTick(); await frame(); await frame();
    expect(view.writes).toEqual([1000]);
  });
});
