import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { effectScope, type ComputedRef } from 'vue';
import { join } from 'node:path';

const probe = vi.hoisted(() => ({
  call: vi.fn(),
  on: vi.fn(),
  handlers: new Map<string, (p: any) => unknown>(),
  lost: vi.fn(),
  connect: vi.fn(async () => {})
}));
vi.mock('../src/renderer/src/rpc', () => ({
  rpc: {
    call: probe.call,
    on: probe.on.mockImplementation((m: string, h: (p: any) => unknown) => probe.handlers.set(m, h)),
    onLost: probe.lost,
    connect: probe.connect
  }
}));

import { useChat } from '../src/renderer/src/stores/chat';
import { initStore, resetStoreRpc, deferred, settleStore } from './renderer-store-fixture';
import { runSetup, renderSfc } from './sfc-setup';
import { markInFlightLoss } from '../src/renderer/src/lib/conn/in-doubt';
import type { ThinkingLevel } from '../src/shared/types';

beforeEach(() => {
  vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem: vi.fn() });
  resetStoreRpc(probe);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const calls = () => probe.call.mock.calls.filter(x => x[0] === 'chat.prompt');

describe('N03 全局偏好与发送', () => {

  for (const level of ['off', 'low', 'medium', 'high'] as ThinkingLevel[]) {
    it('参数与选择一致 ' + level, async () => {
      // 四个选择分别进入真实 store，关档严格保留原来的 RPC 字段集合。
      const c = await initStore(probe);
      c.activeId = 'A';
      c.setThinkingLevel(level);
      await c.send('原样', ['a.png']);
      expect(calls()).toEqual([['chat.prompt', {
        sessionId: 'A',
        text: '原样',
        attachments: ['a.png'],
        promptId: expect.any(String),
        ...(level === 'off' ? {} : { thinkingLevel: level })
      }]]);
    });
  }

  it('localStorage 跨新 store 保留合法档位，无效值与读写异常都有兜底', () => {
    // 新 store 读取持久偏好，四个合法值均能来回写读。
    const mem = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => mem.set(k, v)
    });
    const c = useChat();
    expect(c.thinkingLevel).toBe('off');
    for (const level of ['low', 'medium', 'high', 'off'] as ThinkingLevel[]) {
      c.setThinkingLevel(level);
      expect(mem.get('deskminis.thinkingLevel')).toBe(level);
      setActivePinia(createPinia());
      expect(useChat().thinkingLevel).toBe(level);
    }

    // 坏值回关档；浏览器拒绝读写时，本窗口仍然能改选档位。
    mem.set('deskminis.thinkingLevel', 'invalid');
    setActivePinia(createPinia());
    expect(useChat().thinkingLevel).toBe('off');
    vi.stubGlobal('localStorage', {
      getItem: () => { throw Error('denied'); },
      setItem: () => { throw Error('denied'); }
    });
    setActivePinia(createPinia());
    const locked = useChat();
    expect(locked.thinkingLevel).toBe('off');
    expect(() => locked.setThinkingLevel('high')).not.toThrow();
    expect(locked.thinkingLevel).toBe('high');
  });

  it('普通重试沿用提交时档位，切换全局与重取历史后也不改变', async () => {
    // 本窗口提交有记录时，后来的全局选择不改变原提交的低档。
    const c = await initStore(probe);
    c.activeId = 'A';
    c.setThinkingLevel('low');
    await c.send('原提问');
    c.messages = [{ id: 'REAL', role: 'user', parts: [{ type: 'text', value: '原提问' }] }];
    c.setThinkingLevel('high');
    probe.call.mockClear();
    await c.retryLast();
    expect(calls()[0][1].thinkingLevel).toBe('low');
    expect(c.thinkingLevel).toBe('high');

    // 起跑前被拒的新提问不能覆盖上一条已经提交的记录。
    probe.call.mockRejectedValueOnce(new Error('起跑前拒绝'));
    await c.send('被拒的新提问');
    probe.call.mockClear();
    await c.retryLast();
    expect(calls()[0][1].thinkingLevel).toBe('low');

    // 别的窗口发来的历史没有本窗口记录，使用当前输入卡的高档。
    c.messages = [{ id: 'OTHER', role: 'user', parts: [{ type: 'text', value: '别的窗口的提问' }] }];
    probe.call.mockClear();
    await c.retryLast();
    expect(calls()[0][1].thinkingLevel).toBe('high');
  });

  for (const level of ['off', 'low', 'medium', 'high'] as ThinkingLevel[]) {
    it('无本窗口记录时使用当前输入卡档位，重新 init 清掉旧记录 ' + level, async () => {
      // 先留下旧提交记录，随后新 store 的 init 模拟本窗口重新加载。
      const old = await initStore(probe);
      old.activeId = 'A';
      old.setThinkingLevel('low');
      await old.send('重启前的提问');
      resetStoreRpc(probe);
      const c = await initStore(probe);
      c.activeId = 'A';
      c.messages = [{ id: 'HISTORY', role: 'user', parts: [{ type: 'text', value: '重启前的提问' }] }];
      c.setThinkingLevel(level);

      // 文本相同也不能复用已经清掉的记录，回退由当前选择决定。
      await c.retryLast();
      expect(calls()[0][1]).toEqual({
        sessionId: 'A',
        text: '重启前的提问',
        attachments: [],
        promptId: expect.any(String),
        ...(level === 'off' ? {} : { thinkingLevel: level })
      });
    });
  }

  it('提交等待期间换档不改变本次参数与后续重试档位', async () => {
    // RPC 尚未返回时改成高档，原来的关或低档都应完整保留。
    for (const level of ['off', 'low'] as ThinkingLevel[]) {
      resetStoreRpc(probe);
      const c = await initStore(probe);
      c.activeId = 'A';
      c.setThinkingLevel(level);
      const gate = deferred();
      probe.call.mockReturnValueOnce(gate.promise);
      const pending = c.send('等待的提问');
      c.setThinkingLevel('high');
      gate.resolve({ ok: true });
      await pending;
      probe.call.mockClear();
      await c.retryLast();
      if (level === 'off') expect(calls()[0][1]).not.toHaveProperty('thinkingLevel');
      else expect(calls()[0][1].thinkingLevel).toBe(level);
    }
  });

  it('没有送达与同文重发沿用档位与 promptId，off 也不会借用后来选择', async () => {
    for (const level of ['off', 'medium'] as ThinkingLevel[]) {
      // 断线时捕获原提交档位，关档仍以省略键表达。
      resetStoreRpc(probe);
      const c = await initStore(probe);
      c.activeId = 'A';
      c.syncOn = true;
      c.setThinkingLevel(level);
      probe.call.mockRejectedValueOnce(markInFlightLoss(new Error('断线')));
      await c.send('原提问', ['a.png']);
      expect(c.inDoubtPrompts).toHaveLength(1);
      const u = c.inDoubtPrompts[0];
      expect(u.thinkingLevel).toBe(level === 'off' ? undefined : level);

      // 核对为没有送达之后，改选高档再重试仍沿用旧参数和同一 promptId。
      c.undelivered = u;
      c.setThinkingLevel('high');
      probe.call.mockResolvedValue({ ok: true });
      probe.call.mockClear();
      await c.retryLast();
      expect(calls()[0][1]).toEqual({
        sessionId: 'A',
        text: '原提问',
        attachments: ['a.png'],
        promptId: u.promptId,
        ...(level === 'off' ? {} : { thinkingLevel: level })
      });
    }
  });

  it('排队输入也捕获档位，重发保留原选项；off 不增加键', async () => {
    // 排队输入第一次提交时，把当前中档放入 InputSend。
    const c = await initStore(probe);
    c.activeId = 'A';
    c.inputsOn = true;
    c.setThinkingLevel('medium');
    probe.call.mockResolvedValue({
      input: { sessionId: 'A', messageId: 'I', seq: 1, state: 'pending', updatedAt: 1 },
      duplicate: false
    });
    await c.sendInput('queue', '排队');
    expect(probe.call.mock.calls[0][1].thinkingLevel).toBe('medium');

    // 后来改成关档，重发原输入仍保留原选项，新输入才使用关档。
    const old = probe.call.mock.calls[0][1];
    c.inputRetryBySession.A = old;
    c.setThinkingLevel('off');
    probe.call.mockClear();
    await c.sendInput('queue', '排队');
    expect(probe.call.mock.calls[0][1]).toEqual(old);
    probe.call.mockClear();
    await c.sendInput('queue', '不同提问');
    expect(probe.call.mock.calls[0][1]).not.toHaveProperty('thinkingLevel');
  });
});

interface B {
  thinkingDisabled: ComputedRef<boolean>;
  thinkingReason: ComputedRef<string>;
  thinkingShort: ComputedRef<string>;
  changeThinking(e: Event): void;
  thinkingProvider: ComputedRef<{ id: string } | undefined>;
}
const file = join(__dirname, '../src/renderer/src/ui/Composer.vue');

// 真实组件只替换 RPC 能力应答，选择与禁用状态仍由组件计算。
async function composer(state: string | undefined, adaptive?: boolean) {
  resetStoreRpc(probe);
  const c = await initStore(probe);
  c.providers = [{ id: 'P', name: 'P', hasApiKey: false }];
  c.defaultProviderId = 'P';
  probe.call.mockResolvedValue({
    runtime: state ? { reasoning: { state, reason: '端点能力原因' } } : undefined,
    ...(adaptive === undefined ? {} : { thinkingServerAdaptive: adaptive })
  });
  const s = await runSetup<B>(file, {}, effectScope());
  await settleStore();
  return { c, s };
}

describe('N03 Composer 能力与入口', () => {

  for (const state of ['unsupported', 'unavailable', 'unknown']) {
    it('置灰且说明原因 ' + state, async () => {
      // 明确不可发推理的三种能力状态都禁用，并展示后端原因。
      const { c, s } = await composer(state);
      try {
        expect(s.bindings.thinkingDisabled.value).toBe(true);
        expect(s.bindings.thinkingReason.value).toContain('端点能力原因');
        if (state === 'unknown') expect(s.bindings.thinkingReason.value).toContain('设置 → 模型 → 编辑 → 手动修正');
        const html = await renderSfc(file, {});
        expect(html).toContain('aria-label="思考档位"');
        expect(c.thinkingLevel).toBe('off');
      } finally {
        s.unmount();
      }
    });
  }

  it('服务端自适应置灰；旧应答缺字段与能力取不到时允许选择', async () => {
    // 新字段只认 true；旧应答和能力未取得都不会误禁用。
    for (const [state, adaptive, disabled] of [
      ['supported', true, true],
      ['supported', undefined, false],
      [undefined, undefined, false]
    ] as const) {
      const { s } = await composer(state, adaptive);
      try {
        expect(s.bindings.thinkingDisabled.value).toBe(disabled);
        if (adaptive) expect(s.bindings.thinkingReason.value).toContain('服务端自适应');
      } finally {
        s.unmount();
      }
    }
  });

  it('新槽位能力读取失败时清掉旧禁用结论，仍允许选择', async () => {
    // 从禁用槽位切到能力读取失败的新槽位，旧结论不得残留。
    const { c, s } = await composer('unsupported');
    try {
      expect(s.bindings.thinkingDisabled.value).toBe(true);
      probe.call.mockRejectedValue(new Error('能力暂不可读'));
      c.providers = [{ id: 'P2', name: '新', hasApiKey: false }];
      c.defaultProviderId = 'P2';
      await settleStore();
      expect(s.bindings.thinkingDisabled.value).toBe(false);
      s.bindings.changeThinking({ target: { value: 'low' } } as unknown as Event);
      expect(c.thinkingLevel).toBe('low');
    } finally {
      s.unmount();
    }
  });

  it('选择事件使用实际值，模型组首个有效槽位；晚到旧能力不覆盖新槽位', async () => {
    const { c, s } = await composer('supported');
    try {
      // 选择器使用事件里的值，不写死档位。
      s.bindings.changeThinking({ target: { value: 'medium' } } as unknown as Event);
      expect(c.thinkingLevel).toBe('medium');

      // 模型组跳过已移除的成员，向首个有效槽位取能力。
      const old = deferred();
      probe.call.mockImplementation((_m, p) => p.id === 'P' ? old.promise : Promise.resolve({ runtime: { reasoning: { state: 'supported' } } }));
      c.providers = [{ id: 'P', name: '旧', hasApiKey: false }, { id: 'P2', name: '新', hasApiKey: false }];
      await settleStore();
      c.sessions = [{ id: 'A', title: 'A', modelBinding: 'group:G' }];
      c.activeId = 'A';
      c.messages = [{ id: 'm', role: 'user', parts: [] }];
      c.modelGroups = [{ id: 'G', name: '组', memberIds: ['gone', 'P2'] }];
      await settleStore();
      expect(s.bindings.thinkingProvider.value?.id).toBe('P2');

      // 旧槽位的应答晚到也不能覆盖当前槽位的可用状态。
      old.resolve({ runtime: { reasoning: { state: 'unsupported', reason: '旧响应' } }, thinkingServerAdaptive: true });
      await settleStore();
      expect(s.bindings.thinkingDisabled.value).toBe(false);
      expect(probe.call.mock.calls).toContainEqual(['provider.runtime.resolve', { id: 'P2' }]);
    } finally {
      s.unmount();
    }
  });
});
