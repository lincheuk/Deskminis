import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, type Ref, type ComputedRef } from 'vue';
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

import { initStore, resetStoreRpc, deferred, settleStore } from './renderer-store-fixture';
import { runSetup } from './sfc-setup';

beforeEach(() => resetStoreRpc(probe));
afterEach(() => vi.restoreAllMocks());

describe('N02 真实 store 与 NavRail', () => {

  it('action 等写入成功再刷新，两个实参与应答原样传递，失败不刷新', async () => {
    // 写入应答未返回时只有 setPinned 调用，不得提前刷新列表。
    const c = await initStore(probe);
    const gate = deferred();
    probe.call.mockImplementation(() => gate.promise);
    const task = c.setSessionPinned('N02-B', true);
    expect(probe.call.mock.calls).toEqual([['chat.sessions.setPinned', { sessionId: 'N02-B', pinned: true }]]);

    // 放行写入后再读取列表，并完整采用权威应答。
    const rows = [{ id: 'N02-B', title: 'B', pinnedAt: 123 }];
    probe.call.mockResolvedValue(rows);
    gate.resolve({ ok: true });
    await task;
    expect(probe.call.mock.calls).toEqual([
      ['chat.sessions.setPinned', { sessionId: 'N02-B', pinned: true }],
      ['chat.sessions.list']
    ]);
    expect(c.sessions).toEqual(rows);

    // 写入失败向调用方抛出原错误，且不追加列表刷新。
    probe.call.mockClear();
    probe.call.mockRejectedValue(new Error('写失败'));
    await expect(c.setSessionPinned('N02-C', false)).rejects.toThrow('写失败');
    expect(probe.call.mock.calls).toEqual([['chat.sessions.setPinned', { sessionId: 'N02-C', pinned: false }]]);
  });

  it('菜单操作按当前状态切换，刷新后的真实分组随置顶与取消变化，失败显示原因', async () => {
    // 真实组件和 store 共用合成列表，RPC 桩模拟写入后的权威状态。
    const c = await initStore(probe);
    let pinnedAt: number | undefined;
    const id = 'N02-A';
    const row = () => ({ id, title: '合成会话', updatedAt: Date.now() / 1000, pinnedAt });
    c.sessions = [row()];
    probe.call.mockImplementation(async (m, p) => {
      if (m === 'chat.sessions.setPinned') {
        expect(p.sessionId).toBe(id);
        pinnedAt = p.pinned ? 123 : undefined;
        return { ok: true };
      }
      return [row()];
    });
    vi.spyOn(globalThis, 'setInterval').mockImplementation((() => 0) as never);
    const s = await runSetup<{
      onPin(s: typeof c.sessions[number]): Promise<void>;
      groups: ComputedRef<{ label: string }[]>;
      pinErrs: Ref<Record<string, string>>
    }>(join(__dirname, '../src/renderer/src/ui/NavRail.vue'), { view: 'chat' }, effectScope());
    try {
      // 连点两次菜单操作分别置顶和取消，分组跟随刷新后的数据。
      expect(s.bindings.groups.value.map(g => g.label)).toEqual(['今天']);
      await s.bindings.onPin(c.sessions[0]);
      expect(s.bindings.groups.value.map(g => g.label)).toEqual(['已置顶']);
      await s.bindings.onPin(c.sessions[0]);
      expect(s.bindings.groups.value.map(g => g.label)).toEqual(['今天']);
      expect(probe.call.mock.calls.filter(x => x[0] === 'chat.sessions.setPinned')).toEqual([
        ['chat.sessions.setPinned', { sessionId: id, pinned: true }],
        ['chat.sessions.setPinned', { sessionId: id, pinned: false }]
      ]);

      // 失败原因保留在对应行，异步刷新完成后再检查。
      probe.call.mockRejectedValue(new Error('会话已删除'));
      await s.bindings.onPin(c.sessions[0]);
      await settleStore();
      expect(s.bindings.pinErrs.value[id]).toBe('会话已删除');
    } finally {
      s.unmount();
    }
  });
});
