import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb } from '../src/minisd/store/db';
import { ChatStore } from '../src/minisd/store/chat-store';
import { SyncCoordinator } from '../src/minisd/sync/coordinator';
import type { RpcServer } from '../src/minisd/rpc/server';

let broadcastSpy: ReturnType<typeof vi.fn>;
let rpc: { broadcast: ReturnType<typeof vi.fn> };
let coord: SyncCoordinator;
let chat: ChatStore;

beforeEach(() => {
  const db = openDb(':memory:');
  chat = new ChatStore(db, 'me');
  broadcastSpy = vi.fn();
  rpc = { broadcast: broadcastSpy };
  coord = new SyncCoordinator(chat, rpc as unknown as RpcServer, { debounceMs: 50 });
  chat.onDirty = sid => coord.onDirty(sid);
});
afterEach(() => coord.stop());

describe('SyncCoordinator 事件驱动 pending 队列（服务端被动，评审命门 4）', () => {
  it('appendMessage 后去抖期内广播 sync.dirty', async () => {
    const s = chat.createSession();
    chat.appendMessage({ id: 'A', sessionId: s.id, role: 'user', parts: [], createdAt: 1.0, streamInterruptCount: 0 });
    // 去抖 50ms（测试用短去抖）
    await new Promise(r => setTimeout(r, 100));
    expect(broadcastSpy).toHaveBeenCalledWith('sync.dirty', expect.objectContaining({ sessionId: s.id }));
  });

  it('appendCompactMarker 后触发 sync.dirty', async () => {
    const s = chat.createSession();
    chat.appendMessage({ id: 'A', sessionId: s.id, role: 'user', parts: [], createdAt: 1.0, streamInterruptCount: 0 });
    broadcastSpy.mockClear();
    chat.appendCompactMarker(s.id, '摘要', 'A');
    await new Promise(r => setTimeout(r, 100));
    expect(broadcastSpy).toHaveBeenCalledWith('sync.dirty', expect.objectContaining({ sessionId: s.id }));
  });

  it('连续多次写 → 去抖合并一次广播', async () => {
    const s = chat.createSession();
    broadcastSpy.mockClear();
    chat.appendMessage({ id: 'A', sessionId: s.id, role: 'user', parts: [], createdAt: 1.0, streamInterruptCount: 0 });
    chat.appendMessage({ id: 'B', sessionId: s.id, role: 'user', parts: [], createdAt: 2.0, streamInterruptCount: 0 });
    chat.appendMessage({ id: 'C', sessionId: s.id, role: 'user', parts: [], createdAt: 3.0, streamInterruptCount: 0 });
    await new Promise(r => setTimeout(r, 100));
    const dirtyCalls = broadcastSpy.mock.calls.filter(c => c[0] === 'sync.dirty');
    expect(dirtyCalls.length).toBe(1); // 合并
  });

  it('start() 是空实现（评审命门 4：心跳移除）——不广播 sync.heartbeat', async () => {
    coord.start();
    await new Promise(r => setTimeout(r, 120));
    expect(broadcastSpy).not.toHaveBeenCalledWith('sync.heartbeat', expect.any(Object));
    coord.stop();
  });

  it('stop 后不再广播 sync.dirty', async () => {
    const s = chat.createSession();
    coord.stop();
    broadcastSpy.mockClear();
    chat.appendMessage({ id: 'A', sessionId: s.id, role: 'user', parts: [], createdAt: 1.0, streamInterruptCount: 0 });
    await new Promise(r => setTimeout(r, 100));
    expect(broadcastSpy).not.toHaveBeenCalledWith('sync.dirty', expect.any(Object));
  });
});
