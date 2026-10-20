/** 修复：循环降级（fallback）重播时旧半截正文与新正文拼接。
 *  与 retry 分支同理：fallback 分支必须清空 streamingText，否则模型切到备选后重播，
 *  界面上会看到「旧半截正文 + 新正文」粘在一起。chat.ts 属 renderer 源码守卫范畴。 */
import { describe, it, vi, beforeEach, afterEach } from 'vitest';
const { _rpcCall, _rpcOn, _handlers, _rpcLost, _rpcConnect } = vi.hoisted(() => {
  const handlers = new Map<string, (params: any) => unknown>();
  return { _rpcCall: vi.fn(), _rpcOn: vi.fn((method: string, handler: (params: any) => unknown) => { handlers.set(method, handler); }), _handlers: handlers, _rpcLost: vi.fn(), _rpcConnect: vi.fn(async () => {}) };
});
vi.mock('../src/renderer/src/rpc', () => ({ rpc: { call: _rpcCall, on: _rpcOn, onLost: _rpcLost, connect: _rpcConnect } }));

import { resetStoreRpc } from './renderer-store-fixture';
import { checkBranchStates } from './renderer-store-events';

const _probe = { call: _rpcCall, on: _rpcOn, handlers: _handlers, lost: _rpcLost, connect: _rpcConnect };
// 每例初始化真实 Pinia，记录桩；固定时钟用于事件 timestamp 与 deadline，不以墙钟上界判未发生。
beforeEach(() => {
  resetStoreRpc(_probe);
  vi.spyOn(Date, 'now').mockReturnValue(10000);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('chat.ts fallback 分支清空流式缓冲（源码守卫）', () => {
  it('fallback 分支在更新 fallbackState 前清空 streamingText（与 retry 分支同款防拼接）', async () => {
    // 发布 fallbackState 之前已经清正文与思考；逐个运行来源和缓冲组合观察。
    await checkBranchStates(_probe, 'fallback');
  });

  it('retry 分支既有清空不回归（同为防拼接锚，证明改动是补 fallback 而非新造机制）', async () => {
    // 重试经实际 chat.event 派发；空/非空缓冲及其它会话都不能漏。
    await checkBranchStates(_probe, 'retry');
  });
});
