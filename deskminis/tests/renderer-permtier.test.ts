/**
 * 权限档位预设（permission.preset）渲染端守卫。
 *
 * 背景：permTier 原为本地纯偏好，现在必须真实写后端。本文件用 vi.mock 桩掉 rpc，
 * 断言 chat store 的 setPermTier 真正调用了 permission.setPreset（而非只在本地改一个字段），
 * 以及 init() 从 permission.getPreset 读回档位、RPC 失败时本地值保持原样的三件事。
 *
 * 先红后绿：把 setPermTier 改回「只改 this.permTier」或去掉 init 里的 getPreset 时本文件断言变红。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── mock renderer 的 rpc 模块：桩掉 rpc.call，捕获调用参数 ─────────────────────
const { rpcCallMock } = vi.hoisted(() => ({ rpcCallMock: vi.fn() }));

vi.mock('../src/renderer/src/rpc', () => ({
  rpc: { call: rpcCallMock, connect: async () => {}, on: vi.fn() },
}));

// eslint-disable-next-line import/first —— vi.mock 由 vitest 提升到顶部，此处 import 拿到的是桩
import { createPinia, setActivePinia } from 'pinia';
import { useChat } from '../src/renderer/src/stores/chat';

beforeEach(() => {
  rpcCallMock.mockReset();
  setActivePinia(createPinia());
});

// 让 init() 能跑通的最小桩：各刷新 RPC 返回空/默认，getPreset 单独可控
function stubMinimal(getPreset: unknown = { preset: 'ask' }): void {
  rpcCallMock.mockImplementation(async (method: string) => {
    if (method === 'permission.getPreset') return getPreset;
    if (method === 'chat.sessions.list') return [];
    if (method === 'provider.instances.list') return [];
    if (method === 'skills.list') return [];
    if (method === 'control.status') return { syncPaused: false };
    return undefined;
  });
}

describe('renderer 权限档位预设守卫', () => {
  it('setPermTier 调用 permission.setPreset 并传档位，成功后更新本地值', async () => {
    rpcCallMock.mockResolvedValue({ ok: true });
    const store = useChat();
    await store.setPermTier('full');
    expect(rpcCallMock).toHaveBeenCalledWith('permission.setPreset', { preset: 'full' });
    expect(store.permTier).toBe('full');
  });

  it('setPermTier RPC 失败：抛错且本地值保持原样（高亮不谎报已切换）', async () => {
    rpcCallMock.mockRejectedValue(new Error('boom'));
    const store = useChat();
    store.permTier = 'ask';
    await expect(store.setPermTier('full')).rejects.toThrow();
    expect(store.permTier).toBe('ask');
  });

  it('init() 调用 permission.getPreset 并把返回值应用到 permTier', async () => {
    stubMinimal({ preset: 'full' });
    const store = useChat();
    await store.init();
    expect(rpcCallMock).toHaveBeenCalledWith('permission.getPreset');
    expect(store.permTier).toBe('full');
  });

  it('init() 读回非法档位时保持默认 ask（后端白名单兜底）', async () => {
    stubMinimal({ preset: 'totally-invalid' });
    const store = useChat();
    await store.init();
    expect(store.permTier).toBe('ask');
  });
});