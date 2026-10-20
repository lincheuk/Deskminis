/** B1 会话标题 · renderer 守卫：SessionList 的重命名入口 + chat store 的 renameSession
 *  与 chat.sessions.changed 订阅。.vue 不在 typecheck 覆盖内，这层只能靠源码文本守卫兜底
 *  （沿用 renderer-sessioncard.test.ts 的做法）。 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
const { _rpcCall, _rpcOn, _handlers, _rpcLost, _rpcConnect } = vi.hoisted(() => {
  const handlers = new Map<string, (params: any) => unknown>();
  return { _rpcCall: vi.fn(), _rpcOn: vi.fn((method: string, handler: (params: any) => unknown) => { handlers.set(method, handler); }), _handlers: handlers, _rpcLost: vi.fn(), _rpcConnect: vi.fn(async () => {}) };
});
vi.mock('../src/renderer/src/rpc', () => ({ rpc: { call: _rpcCall, on: _rpcOn, onLost: _rpcLost, connect: _rpcConnect } }));

import fs from 'node:fs';
import path from 'node:path';

import { resetStoreRpc, initStore, dispatchStore, deferred } from './renderer-store-fixture';

const root = path.resolve(__dirname, '..');

const _probe = { call: _rpcCall, on: _rpcOn, handlers: _handlers, lost: _rpcLost, connect: _rpcConnect };
// 每例使用新的真实 Pinia；RPC 桩只记调用与订阅，由用例放行应答。
beforeEach(() => { resetStoreRpc(_probe); });
afterEach(() => { vi.restoreAllMocks(); });

describe('B1 会话标题：renderer 守卫（2 例）', () => {
  it('chat store：renameSession 调 chat.sessions.rename，并订阅 chat.sessions.changed 刷列表（后端自动命名靠这条广播才看得见）', async () => {
    // rename 的两个实参、成功后刷新与 state；订阅实际派发自动命名广播。
    const chat = await initStore(_probe);
    const old = [{ id: 'S', title: 'old' }];
    const updated = [{ id: 'S', title: 'new title' }];
    chat.sessions = old;
    const rename = deferred();
    _rpcCall.mockReturnValueOnce(rename.promise).mockResolvedValueOnce(updated);
    const renaming = chat.renameSession('S', 'new title');
    expect(_rpcCall.mock.calls).toEqual([['chat.sessions.rename', { sessionId: 'S', title: 'new title' }]]);
    expect(chat.sessions).toEqual(old);
    rename.resolve({ ok: true });
    await renaming;
    expect(_rpcCall.mock.calls).toEqual([['chat.sessions.rename', { sessionId: 'S', title: 'new title' }], ['chat.sessions.list']]);
    expect(chat.sessions).toEqual(updated);
    _rpcCall.mockClear();
    _rpcCall.mockResolvedValueOnce([{ id: 'S', title: 'auto title' }]);
    await dispatchStore(_probe, 'chat.sessions.changed', {});
    expect(_rpcOn.mock.calls.filter(c => c[0] === 'chat.sessions.changed')).toHaveLength(1);
    expect(_rpcCall.mock.calls).toEqual([['chat.sessions.list']]);
    expect(chat.sessions[0].title).toBe('auto title');
  });

  /* 「SessionList 菜单有重命名项」在 T6e-3 退场（T 波换壳时会话行的 ⋮ 菜单没搬过来，
     `chat.renameSession` 在 ui/ 下零引用）；Y1（2026-09-10）在 ui/NavRail.vue 上补回，本例复位。 */
  it('NavRail 会话行菜单有重命名项：预填现标题、Enter 或「确认」提交、后端拒绝原因落在菜单里（Y1 复位）', () => {
    const rail = fs.readFileSync(path.join(root, 'src/renderer/src/ui/NavRail.vue'), 'utf8');
    expect(rail).toMatch(/\.renameSession\(/);
    expect(rail).toMatch(/@click\.stop="startRename\(s\)"/);
    expect(rail).toMatch(/@keydown\.enter="submitRename\(s\.id\)"/);
    expect(rail).toContain('renameErr');
  });
});
