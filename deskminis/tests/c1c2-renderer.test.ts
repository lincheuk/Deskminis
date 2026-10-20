/** 补充23：真实 store + 实际 SFC 模板，不以源码断言代替行为。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, isVNode, nextTick, type VNode } from 'vue';
import { join } from 'node:path';
import { initStore, minimalReply, resetStoreRpc, type Chat } from './renderer-store-fixture';
import { runSetup, type SetupRun } from './sfc-setup';

const probe = vi.hoisted(() => ({ call: vi.fn(), on: vi.fn(), handlers: new Map(), lost: vi.fn(), connect: vi.fn() }));
vi.mock('../src/renderer/src/rpc', () => ({ rpc: {
  call: probe.call, connect: probe.connect, onLost: probe.lost,
  on: (m: string, h: (p: any) => unknown) => { probe.handlers.set(m, h); },
} }));

const source = join(__dirname, '../src/renderer/src');
type Render = (ctx: object, cache: unknown[]) => VNode;
let chat: Chat;
const mounted: SetupRun<any>[] = [];
const frames = new Map<number, FrameRequestCallback>();
let frameId = 0;
const write = vi.fn();
function all(v: unknown): VNode[] { return Array.isArray(v) ? v.flatMap(all) : isVNode(v) ? [v, ...all(v.children)] : []; }
const hasClass = (n: VNode, name: string) => String(n.props?.class ?? '').split(/\s+/).includes(name);
const components = (tree: VNode, name: string) => all(tree).filter(n => typeof n.type === 'object' && 'name' in n.type && String(n.type.name).endsWith(name));
const buttons = (tree: VNode) => all(tree).filter(n => n.type === 'button' && n.props?.['aria-label'] === '复制这条回复');
const texts = (v: unknown): string => Array.isArray(v) ? v.map(texts).join('') : isVNode(v) ? texts(v.children) : typeof v === 'string' ? v : '';
async function setup(file: string, props = {}) {
  const run = await runSetup<Render>(join(source, file), props, effectScope(), { inlineTemplate: true });
  mounted.push(run); run.mount();
  return () => run.bindings({}, []);
}
async function frame() { const jobs = [...frames.values()]; frames.clear(); jobs.forEach(f => f(16)); await nextTick(); }
const msg = (id: string, role: 'assistant' | 'user', parts: any[], reasoningContent?: string) => ({ id, sessionId: 's', role, parts, reasoningContent, createdAt: 1, sortOrder: 1, streamInterruptCount: 0 });
async function history(rows: any[]) {
  probe.call.mockImplementation((method: string) => method === 'chat.messages.list' ? Promise.resolve(rows) : minimalReply(method));
  await chat.open('s'); await nextTick();
}

beforeEach(async () => {
  resetStoreRpc(probe);
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }), addEventListener: vi.fn(), removeEventListener: vi.fn() });
  frames.clear(); frameId = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { const id = frameId++; frames.set(id, cb); return id; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  write.mockReset(); write.mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText: write } });
  chat = await initStore(probe);
});
afterEach(() => { mounted.splice(0).forEach(r => r.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('占位思考与实时解析接线', () => {
  it('历史只隐藏占位，store 原文不变，真思考仍渲染', async () => {
    const original = '  NO REASONING AVAILABLE.\n';
    await history([msg('u', 'user', []), msg('a', 'assistant', [{ type: 'text', value: '回答' }], original)]);
    const render = await setup('ui/StageChat.vue');
    expect(components(render(), 'ThinkBlock.vue')).toHaveLength(0);
    expect(chat.messages[1].reasoningContent).toBe(original);
    await history([msg('u', 'user', []), msg('a', 'assistant', [], 'No, wait')]);
    expect(components(render(), 'ThinkBlock.vue')[0].props?.text).toBe('No, wait');
  });

  it('历史严格前缀照常显示思考，保留原文', async () => {
    const render = await setup('ui/StageChat.vue');
    for (const prefix of ['No', 'No reasoning']) {
      await history([msg('u', 'user', []), msg('a', 'assistant', [], prefix)]);
      const thoughts = components(render(), 'ThinkBlock.vue');
      expect(thoughts).toHaveLength(1);
      expect(thoughts[0].props?.text).toBe(prefix);
      expect(chat.messages[1].reasoningContent).toBe(prefix);
    }
  });

  it('实时前缀不闪，分歧第一帧出现，缓冲原文不变', async () => {
    chat.running = true;
    const render = await setup('ui/LiveTurn.vue');
    for (const value of ['No reas', 'No reasoning available.', ' \n ']) {
      chat.streamingThinking = value; await frame();
      expect(components(render(), 'ThinkBlock.vue')).toHaveLength(0);
      expect(chat.streamingThinking).toBe(value);
    }
    for (const value of ['No, wait', 'Let me think']) {
      chat.streamingThinking = value; await frame();
      expect(components(render(), 'ThinkBlock.vue')[0].props).toMatchObject({ text: value, live: '' });
    }
  });

  it('LiveTurn 画 open 代码，同样输入在历史仍为段落', async () => {
    const raw = '```ts\nx()';
    chat.streamingText = raw;
    const live = await setup('ui/LiveTurn.vue');
    expect(components(live(), 'MarkdownView.vue')[0].props?.nodes).toEqual([{ type: 'codeBlock', lang: 'ts', code: 'x()', open: true }]);
    chat.streamingText = '';
    await history([msg('a', 'assistant', [{ type: 'text', value: raw }])]);
    const stage = await setup('ui/StageChat.vue');
    const nodes = components(stage(), 'MarkdownView.vue')[0].props?.nodes;
    expect(nodes.every((n: any) => n.type === 'paragraph')).toBe(true);
  });

  it('open 代码不存在按钮，闭合后复制完整代码', async () => {
    const open = await setup('components/MarkdownView.vue', { nodes: [{ type: 'codeBlock', lang: 'ts', code: 'x()', open: true }] });
    expect(all(open()).filter(n => n.type === 'button')).toHaveLength(0);
    const placeholder = all(open()).find(n => hasClass(n, 'md-copy-placeholder'));
    expect(placeholder?.props?.['aria-hidden']).toBe('true');
    const closed = await setup('components/MarkdownView.vue', { nodes: [{ type: 'codeBlock', lang: 'ts', code: 'x()\ny()' }] });
    await all(closed()).find(n => n.type === 'button')!.props!.onClick();
    expect(write).toHaveBeenCalledWith('x()\ny()');
    expect(texts(closed())).toContain('已复制');
  });
});

describe('C2 历史回复复制', () => {
  async function turns() {
    await history([
      msg('u1', 'user', [{ type: 'text', value: '用户正文' }, { type: 'mediaRef', value: { relativePath: 'x.png' } }]),
      msg('a1', 'assistant', [{ type: 'text', value: '**第一段**' }], '真实思考'),
      msg('a2', 'assistant', [{ type: 'toolUse', value: { toolUseId: 't', name: 'file_read', input: '{}' } }]),
      msg('r1', 'tool' as any, [{ type: 'toolResult', value: { toolUseId: 't', output: '工具输出', ok: true } }]),
      msg('a3', 'assistant', [{ type: 'text', value: '```ts\nx()\n```' }]),
      msg('u2', 'user', []), msg('a4', 'assistant', [{ type: 'text', value: '第二回合' }]),
    ]);
    return setup('ui/StageChat.vue');
  }

  it('复制所有正文原文，反馈 1.2 秒，同一时刻仅一个回合反馈', async () => {
    const render = await turns(); vi.useFakeTimers();
    expect(buttons(render())).toHaveLength(2);
    await buttons(render())[0].props!.onClick();
    expect(write).toHaveBeenLastCalledWith('**第一段**\n\n```ts\nx()\n```');
    expect(texts(buttons(render())[0])).toBe('已复制');
    await vi.advanceTimersByTimeAsync(500);
    await buttons(render())[1].props!.onClick();
    expect(write).toHaveBeenLastCalledWith('第二回合');
    expect(buttons(render()).map(texts)).toEqual(['复制', '已复制']);
    await vi.advanceTimersByTimeAsync(1199);
    expect(texts(buttons(render())[1])).toBe('已复制');
    await vi.advanceTimersByTimeAsync(1);
    expect(buttons(render()).map(texts)).toEqual(['复制', '复制']);
  });

  it('只有思考/工具/附件没有复制入口', async () => {
    await history([msg('u', 'user', []), msg('a', 'assistant', [{ type: 'toolUse', value: { name: 'file_read' } }, { type: 'mediaRef', value: {} }], '思考')]);
    expect(buttons((await setup('ui/StageChat.vue'))())).toHaveLength(0);
  });

  it('最后回合运行与收尾待历史时均没有按钮，前回合保留', async () => {
    const render = await turns();
    chat.running = true; await nextTick();
    expect(buttons(render())).toHaveLength(1);
    chat.running = false; await nextTick();
    expect(buttons(render())).toHaveLength(1);
    chat.messages = [...chat.messages]; await nextTick();
    expect(buttons(render())).toHaveLength(2);
  });

  it('在跑及收尾期间只给前回合复制，历史取回后两回合都有', async () => {
    const render = await turns();
    const turn = (id: string) => all(render()).find(n => n.type === 'section' && n.props?.['data-turn-id'] === id)!;
    chat.running = true; await nextTick();
    expect(buttons(turn('u1'))).toHaveLength(1);
    expect(buttons(turn('u2'))).toHaveLength(0);
    await buttons(turn('u1'))[0].props!.onClick();
    expect(write).toHaveBeenLastCalledWith('**第一段**\n\n```ts\nx()\n```');
    chat.running = false; await nextTick();
    expect(buttons(turn('u1'))).toHaveLength(1);
    expect(buttons(turn('u2'))).toHaveLength(0);
    chat.messages = [...chat.messages]; await nextTick();
    expect(buttons(turn('u1'))).toHaveLength(1);
    expect(buttons(turn('u2'))).toHaveLength(1);
  });

  it('剪贴板不可用静默，文案不变；反馈行不归入注释正文', async () => {
    const render = await turns();
    write.mockRejectedValueOnce(new Error('denied'));
    await expect(buttons(render())[0].props!.onClick()).resolves.toBeUndefined();
    expect(texts(buttons(render())[0])).toBe('复制');
    const row = all(render()).find(n => hasClass(n, 'turn-actions'))!;
    expect(row.props).not.toHaveProperty('data-anno-root');
    expect(all(row).some(n => Object.hasOwn(n.props ?? {}, 'data-anno-root'))).toBe(false);
  });
});
