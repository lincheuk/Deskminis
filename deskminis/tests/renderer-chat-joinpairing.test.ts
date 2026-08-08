/**
 * M4.6 Task 3 · joinPairing 真行为测试（评审修订 1 落地）
 *
 * 评审退回项：旧的 renderer-m3c.test.ts 里 `expect(seg).toContain('listenPort')` 是源码子串匹配，
 * 比「断言传了参数」还弱一档——在 joinPairing 里写一行注释或没用到的 `const listenPort` 照样绿，
 * 无法证明「listenPort 到达 join RPC」。本文件用 vi.mock 桩掉 rpc.call，捕获真实调用参数，
 * 断言「传出去的值正确」而非「源码里出现了这个词」，并覆盖「取不到端口不阻塞配对」的负路径。
 *
 * 先红后绿：将 chat.ts 的透传改回原样（listenPort 传 undefined 或错误值）时本文件断言变红。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── mock renderer 的 rpc 模块：桩掉 rpc.call，捕获调用参数 ─────────────────────
// vi.hoisted 保证 mock 工厂里能引用同一 fn 实例；chat.ts 顶层 `import { rpc } from '../rpc'`
// 拿到的是这份桩，joinPairing/refreshDevices 里的 rpc.call 都会落到 rpcCallMock。
const { rpcCallMock } = vi.hoisted(() => ({ rpcCallMock: vi.fn() }));

vi.mock('../src/renderer/src/rpc', () => ({
  rpc: { call: rpcCallMock },
}));

// eslint-disable-next-line import/first —— vi.mock 由 vitest 提升到顶部，此处 import 拿到的是桩
import { createPinia, setActivePinia } from 'pinia';
import { useChat } from '../src/renderer/src/stores/chat';

/** 按 method 分发 mock 返回值：join 返回 peerFingerprint，status 返回空设备表（refreshDevices 用）。 */
function stubJoinAndStatus(peerFingerprint = 'AAA') {
  rpcCallMock.mockImplementation(async (method: string) => {
    if (method === 'remote.pair.join') return { peerFingerprint };
    if (method === 'remote.status') return { devices: [] };
    return undefined;
  });
}

/** 取 joinPairing 里最近一次对 `remote.pair.join` 的调用参数。 */
function lastJoinCallParams(): any {
  const joins = rpcCallMock.mock.calls.filter(([m]) => m === 'remote.pair.join');
  return joins[joins.length - 1]?.[1];
}

// 测试环境为 node，无 window；为 minisdInfo 桩提供全局 window（沿用 rpc.ts 同款探访问法）
const originalWindow = (globalThis as any).window;

beforeEach(() => {
  rpcCallMock.mockReset();
  stubJoinAndStatus();
  setActivePinia(createPinia());
});

afterEach(() => {
  VI_REQUEST_ANNOTATION_window_restore();
});

function VI_REQUEST_ANNOTATION_window_restore() {
  if (originalWindow === undefined) delete (globalThis as any).window;
  else (globalThis as any).window = originalWindow;
}

describe('M4.6 Task 3 — joinPairing 透传 listenPort（评审修订 1：断言值而非词）', () => {
  it('正路径：rpc.call 以 remote.pair.join 调用，listenPort 严格等于 minisdInfo 返回端口', async () => {
    (globalThis as any).window = { deskminis: { minisdInfo: async () => ({ port: 54321, token: 't' }) } };

    const store = useChat();
    const fp = await store.joinPairing({ host: 'hostX', port: 9000, pairingCode: 'CODE' });

    // 以 remote.pair.join 调用，且第二参带的 listenPort 严格等于 54321（toBe，非 toContain）
    expect(rpcCallMock).toHaveBeenCalledWith('remote.pair.join', expect.objectContaining({ listenPort: 54321 }));
    expect(lastJoinCallParams()).toMatchObject({ host: 'hostX', port: 9000, pairingCode: 'CODE', listenPort: 54321 });
    expect(lastJoinCallParams().listenPort).toBe(54321);
    expect(String(fp)).toBe('AAA');
  });

  it('显式传入 listenPort 优先：不覆盖调用方明确给定的值', async () => {
    (globalThis as any).window = { deskminis: { minisdInfo: async () => ({ port: 54321 }) } };

    const store = useChat();
    await store.joinPairing({ host: 'h', port: 1, pairingCode: 'C', listenPort: 9876 });

    expect(lastJoinCallParams().listenPort).toBe(9876);
    expect(rpcCallMock).toHaveBeenCalledWith('remote.pair.join', expect.objectContaining({ listenPort: 9876 }));
  });

  it('负路径：minisdInfo 抛错 → listenPort undefined 且配对不被阻塞（rpc.call 仍被调用）', async () => {
    (globalThis as any).window = { deskminis: { minisdInfo: async () => { throw new Error('bridge gone'); } } };

    const store = useChat();
    const fp = await store.joinPairing({ host: 'hostX', port: 9000, pairingCode: 'CODE' });

    // 配对仍执行（不因取端口失败而中断）；listenPort 为 undefined（维持现状）
    expect(rpcCallMock).toHaveBeenCalledWith('remote.pair.join', expect.anything());
    expect(lastJoinCallParams().listenPort).toBeUndefined();
    expect(String(fp)).toBe('AAA');
  });
});