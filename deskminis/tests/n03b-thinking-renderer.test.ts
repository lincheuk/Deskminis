import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { effectScope, type VNode } from 'vue';
import { join } from 'node:path';

const probe = vi.hoisted(() => ({ call: vi.fn(), on: vi.fn(), handlers: new Map<string, (p: any) => unknown>(), lost: vi.fn(), connect: vi.fn(async () => {}) }));
vi.mock('../src/renderer/src/rpc', () => ({ rpc: {
  call: probe.call, on: probe.on.mockImplementation((m: string, h: (p: any) => unknown) => probe.handlers.set(m, h)), onLost: probe.lost, connect: probe.connect,
} }));
import { useChat } from '../src/renderer/src/stores/chat';
import { initStore, resetStoreRpc, settleStore, deferred } from './renderer-store-fixture';
import { runSetup } from './sfc-setup';
import { markInFlightLoss } from '../src/renderer/src/lib/conn/in-doubt';
import { NEW_LEVELS } from './n03b-thinking-fixture';

beforeEach(() => { vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem: vi.fn() }); resetStoreRpc(probe); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const prompts = () => probe.call.mock.calls.filter(x => x[0] === 'chat.prompt');
const file = join(__dirname, '../src/renderer/src/ui/Composer.vue');
function nodes(v: unknown): VNode[] {
  if (Array.isArray(v)) return v.flatMap(nodes);
  if (!v || typeof v !== 'object' || !('type' in v)) return [];
  const n = v as VNode;
  return [n, ...nodes(n.children)];
}
const runtime = (efforts?: string[], param = 'effort', state = 'supported') => ({ protocol: param === 'budget' ? 'anthropic' : 'openai-chat', endpoint: { class: 'catalog' }, reasoning: { state, param, control: efforts ? { efforts } : undefined } });
const declared = { xhigh: { level: 'xhigh' }, max: { level: 'max' } };
const highPreview = { xhigh: { level: 'high', note: '引擎预告：当前端点没有声明这一档，本轮按 high 发送' }, max: { level: 'high', note: '引擎预告：当前端点没有声明这一档，本轮按 high 发送' } };
async function composer(rt: any, thinkingPreview?: any) {
  const c = await initStore(probe);
  c.providers = [{ id: 'A', name: '合成槽位', hasApiKey: false }]; c.defaultProviderId = 'A';
  probe.call.mockResolvedValue({ runtime: rt, thinkingPreview, thinkingServerAdaptive: false });
  const s = await runSetup<(ctx: object, cache: unknown[]) => VNode>(file, {}, effectScope(), { inlineTemplate: true });
  await settleStore();
  const render = () => s.bindings({}, []);
  const select = () => nodes(render()).find(n => n.type === 'select' && n.props?.['aria-label'] === '思考档位')!;
  const options = () => nodes(select().children).filter(n => n.type === 'option');
  return { c, s, select, options, render };
}

describe('N03b 窗口内偏好与重发', () => {
  for (const level of NEW_LEVELS) {
    it('本机新档位可读可写、普通提交与重试沿用 ' + level, async () => {
      const mem = new Map([['deskminis.thinkingLevel', level as string]]);
      vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => mem.set(k, v) });
      const c = await initStore(probe); c.activeId = 'A';
      expect(c.thinkingLevel).toBe(level);
      await c.send('原提问');
      expect(prompts().at(-1)?.[1].thinkingLevel).toBe(level);
      c.setThinkingLevel('low'); probe.call.mockClear();
      await c.retryLast();
      expect(prompts().at(-1)?.[1].thinkingLevel).toBe(level);
      c.setThinkingLevel(level); setActivePinia(createPinia());
      expect(useChat().thinkingLevel).toBe(level);
      mem.set('deskminis.thinkingLevel', 'garbage'); setActivePinia(createPinia());
      expect(useChat().thinkingLevel).toBe('off');
    });

    it('没有送达与排队重发保留新档位 ' + level, async () => {
      const c = await initStore(probe); c.activeId = 'A'; c.syncOn = true; c.setThinkingLevel(level);
      probe.call.mockRejectedValueOnce(markInFlightLoss(new Error('断线')));
      await c.send('未送达'); c.undelivered = c.inDoubtPrompts[0];
      c.setThinkingLevel('low'); probe.call.mockResolvedValue({ ok: true }); probe.call.mockClear();
      await c.retryLast(); expect(prompts().at(-1)?.[1].thinkingLevel).toBe(level);
      c.inputsOn = true; c.setThinkingLevel(level);
      probe.call.mockResolvedValue({ input: { sessionId: 'A', messageId: 'I', seq: 1, state: 'pending', updatedAt: 1 } }); probe.call.mockClear();
      await c.sendInput('queue', '排队');
      const original = probe.call.mock.calls.find(x => x[0] === 'chat.input.send')![1];
      expect(original.thinkingLevel).toBe(level);
      c.inputRetryBySession.A = original; c.setThinkingLevel('low'); probe.call.mockClear();
      await c.sendInput('queue', '排队');
      expect(probe.call.mock.calls.find(x => x[0] === 'chat.input.send')![1]).toEqual(original);
    });
  }
});

describe('N03b 实际模板选择器', () => {
  it('六选项只按引擎预告可选，runtime本身的声明不替代预告', async () => {
    const { c, s, select, options } = await composer(runtime(['low', 'high']), declared);
    try {
      expect(options().map(n => n.props?.value)).toEqual(['off', 'low', 'medium', 'high', 'xhigh', 'max']);
      expect(options().map(n => n.children)).toEqual(['思考：关', '思考：低', '思考：中', '思考：高', '思考：超高', '思考：最高']);
      expect(options().map(n => n.props?.disabled)).toEqual([false, false, false, false, false, false]);
      select().props!.onChange({ target: { value: 'xhigh' } }); expect(c.thinkingLevel).toBe('xhigh');
      select().props!.onChange({ target: { value: 'max' } }); expect(c.thinkingLevel).toBe('max');
      probe.call.mockResolvedValue({ runtime: runtime(['low', 'medium', 'high', 'xhigh', 'max']), thinkingPreview: { ...declared, xhigh: highPreview.xhigh } });
      c.providers = [{ id: 'B', name: '只声明最高', hasApiKey: false }]; c.defaultProviderId = 'B'; await settleStore();
      expect(options().slice(-2).map(n => n.props?.disabled)).toEqual([true, false]);
    } finally { s.unmount(); }
  });

  it('换槽位保留超高、置灰原因和实际发送档位均只读预告', async () => {
    const { c, s, select, options, render } = await composer(runtime(['low', 'medium', 'high', 'xhigh', 'max']), declared);
    try {
      c.setThinkingLevel('xhigh');
      probe.call.mockResolvedValue({ runtime: runtime(['low', 'medium', 'high', 'xhigh', 'max']), thinkingPreview: highPreview });
      c.providers = [{ id: 'B', name: '三档', hasApiKey: false }]; c.defaultProviderId = 'B'; await settleStore();
      expect(c.thinkingLevel).toBe('xhigh'); expect(select().props?.value).toBe('xhigh');
      expect(options().slice(-2).map(n => n.props?.disabled)).toEqual([true, true]);
      expect(options().at(-1)?.props?.title).toBe(highPreview.max.note);
      expect(select().props?.title).toContain(highPreview.xhigh.note);
      expect(nodes(render()).find(n => n.props?.class === 'thinking-note t-aux')?.children).toBe('本轮按高发送');
      probe.call.mockResolvedValue({ runtime: runtime(['low', 'high', 'max']), thinkingPreview: { xhigh: { level: 'medium', note: '引擎实际按中' }, max: { level: 'off', note: '引擎关闭' } } });
      c.providers = [{ id: 'C', name: '稀疏档位', hasApiKey: false }]; c.defaultProviderId = 'C'; await settleStore();
      expect(nodes(render()).find(n => n.props?.class === 'thinking-note t-aux')?.children).toBe('本轮按中发送');
    } finally { s.unmount(); }
  });

  for (const [name, preview] of [
    ['预算', { level: 'high', budgetTokens: 1234, note: '引擎：这个接入按推理预算控制，最多到高' }],
    ['只有开关', { level: 'off', note: '引擎：推理参数是开关，当前接入只发送 reasoning_effort 档位，本轮未开启推理' }],
    ['空控制', { level: 'off', note: '引擎：目录记录没有列出可调的推理参数，不另发推理参数' }],
  ] as const) {
    it('预算与关闭结果按预告置灰并展示原因 ' + name, async () => {
      const { c, s, select, options, render } = await composer(runtime(['xhigh', 'max']), { xhigh: preview, max: preview });
      try {
        expect(select().props?.disabled).toBe(false);
        expect(options().slice(-2).every(n => n.props?.disabled === true)).toBe(true);
        expect(options().at(-1)?.props?.title).toBe(preview.note);
        c.setThinkingLevel('max');
        expect(nodes(render()).find(n => n.props?.class === 'thinking-note t-aux')?.children).toBe(preview.level === 'off' ? '本轮按关发送' : '本轮按高发送');
      } finally { s.unmount(); }
    });
  }

  it('预告取不到或漏单项时只禁用对应新项，原因是能力未取得', async () => {
    const { c, s, select, options } = await composer(runtime(['xhigh', 'max']));
    try {
      expect(select().props?.disabled).toBe(false);
      expect(options().map(n => n.props?.disabled)).toEqual([false, false, false, false, true, true]);
      expect(options().at(-1)?.props?.title).toBe('能力未取得');
      probe.call.mockResolvedValue({ runtime: runtime(['xhigh', 'max']), thinkingPreview: { xhigh: declared.xhigh } });
      c.providers = [{ id: 'B', name: '旧预告', hasApiKey: false }]; c.defaultProviderId = 'B'; await settleStore();
      expect(options().slice(-2).map(n => n.props?.disabled)).toEqual([false, true]);
      expect(options().at(-1)?.props?.title).toBe('能力未取得');
    } finally { s.unmount(); }
  });

  it('旧槽位晚到的预告不能覆盖新槽位，取数期间清掉旧预告', async () => {
    const { c, s, options } = await composer(runtime(['xhigh', 'max']), declared);
    try {
      const old = deferred();
      probe.call.mockImplementation((_m, p) => p.id === 'B' ? old.promise : Promise.resolve({ runtime: runtime(['xhigh', 'max']), thinkingPreview: highPreview }));
      c.providers = [{ id: 'B', name: '慢槽位', hasApiKey: false }]; c.defaultProviderId = 'B'; await settleStore();
      expect(options().slice(-2).map(n => n.props?.title)).toEqual(['能力未取得', '能力未取得']);
      c.providers = [{ id: 'C', name: '新槽位', hasApiKey: false }]; c.defaultProviderId = 'C'; await settleStore();
      expect(options().slice(-2).map(n => n.props?.disabled)).toEqual([true, true]);
      old.resolve({ runtime: runtime(['xhigh', 'max']), thinkingPreview: declared }); await settleStore();
      expect(options().slice(-2).map(n => n.props?.disabled)).toEqual([true, true]);
      expect(options().at(-1)?.props?.title).toBe(highPreview.max.note);
    } finally { s.unmount(); }
  });
});
