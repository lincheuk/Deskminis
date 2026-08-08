import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb } from '../src/minisd/store/db';
import { ChatStore } from '../src/minisd/store/chat-store';
import { SyncCoordinator } from '../src/minisd/sync/coordinator';
import type { RpcServer } from '../src/minisd/rpc/server';

// M6 决策点 2-5/2-7：暂停阀影响 flush 的 broadcast+push 与 reconcile 的 push，但保留 pull / 收下合并。
let broadcastSpy: ReturnType<typeof vi.fn>;
let rpc: { broadcast: ReturnType<typeof vi.fn> };
let coord: SyncCoordinator;
let chat: ChatStore;

function makeOutbound() {
  return {
    dialedPeers: vi.fn(() => ['peerB']),
    callRpc: vi.fn(async () => ({ sessions: [] })),
    start: vi.fn(),
    stop: vi.fn(),
    onRemoteDirty: undefined,
    onOnline: undefined,
  } as any;
}

beforeEach(() => {
  const db = openDb(':memory:');
  chat = new ChatStore(db, 'me');
  broadcastSpy = vi.fn();
  rpc = { broadcast: broadcastSpy };
  coord = new SyncCoordinator(chat, rpc as unknown as RpcServer, { debounceMs: 50 });
  chat.onDirty = sid => coord.onDirty(sid);
});
afterEach(() => coord.stop());

describe('M6 R2 暂停阀（flush：暂停时本端不广播不 push）', () => {
  it('暂停时 flush 不广播 sync.dirty（本端 dirty 被丢弃）', async () => {
    const s = chat.createSession();
    coord.setPaused(true);
    broadcastSpy.mockClear();
    chat.appendMessage({ id: 'A', sessionId: s.id, role: 'user', parts: [], createdAt: 1.0, streamInterruptCount: 0 });
    await new Promise(r => setTimeout(r, 100));
    expect(broadcastSpy).not.toHaveBeenCalledWith('sync.dirty', expect.any(Object));
  });

  it('解除暂停后 flush 恢复广播 sync.dirty', async () => {
    const s = chat.createSession();
    coord.setPaused(true);
    coord.setPaused(false);
    broadcastSpy.mockClear();
    chat.appendMessage({ id: 'A', sessionId: s.id, role: 'user', parts: [], createdAt: 1.0, streamInterruptCount: 0 });
    await new Promise(r => setTimeout(r, 100));
    expect(broadcastSpy).toHaveBeenCalledWith('sync.dirty', expect.objectContaining({ sessionId: s.id }));
  });

  it('暂停时 flush 不 push（拨号方职责也停）', async () => {
    const outbound = makeOutbound();
    coord = new SyncCoordinator(chat, rpc as unknown as RpcServer, { debounceMs: 50, outbound });
    chat.onDirty = sid => coord.onDirty(sid);
    const s = chat.createSession();
    coord.setPaused(true);
    chat.appendMessage({ id: 'A', sessionId: s.id, role: 'user', parts: [], createdAt: 1.0, streamInterruptCount: 0 });
    await new Promise(r => setTimeout(r, 100));
    expect(outbound.callRpc).not.toHaveBeenCalled();
  });
});

describe('M6 R2 暂停阀（reconcile：暂停时跳 push 但保留 pull）', () => {
  it('暂停时 reconcile 不 push 但调 sync.list（pull 照常）', async () => {
    const outbound = makeOutbound();
    const s = chat.createSession();
    chat.appendMessage({ id: 'A', sessionId: s.id, role: 'user', parts: [], createdAt: 1.0, streamInterruptCount: 0 });
    outbound.callRpc.mockResolvedValue({ sessions: [{ id: 'remote-s' }] });
    coord = new SyncCoordinator(chat, rpc as unknown as RpcServer, { debounceMs: 50, outbound });
    coord.setPaused(true);
    // start() 挂 onOnline → 触发 reconcilePeer；暂停时跳过 push 段
    coord.start();
    outbound.onOnline('peerB');
    await new Promise(r => setTimeout(r, 100));
    // push 方向：不应有 sync.push 调用
    const pushCalls = outbound.callRpc.mock.calls.filter((c: any[]) => c[1] === 'sync.push');
    expect(pushCalls.length).toBe(0);
    // pull 方向：sync.list 应被调用（保留 pull）
    const listCalls = outbound.callRpc.mock.calls.filter((c: any[]) => c[1] === 'sync.list');
    expect(listCalls.length).toBe(1);
  });

  it('未暂停时 reconcile 会 push', async () => {
    const outbound = makeOutbound();
    const s = chat.createSession();
    chat.appendMessage({ id: 'A', sessionId: s.id, role: 'user', parts: [], createdAt: 1.0, streamInterruptCount: 0 });
    outbound.callRpc.mockResolvedValue({ sessions: [] });
    coord = new SyncCoordinator(chat, rpc as unknown as RpcServer, { debounceMs: 50, outbound });
    coord.setPaused(false);
    coord.start();
    outbound.onOnline('peerB');
    await new Promise(r => setTimeout(r, 100));
    const pushCalls = outbound.callRpc.mock.calls.filter((c: any[]) => c[1] === 'sync.push');
    expect(pushCalls.length).toBe(1);
  });

  it('守卫：已在线连接调 setPaused(false) 不重连（dialed=已拨过号，非 start 被调过）', async () => {
    // 场景：正常启动已拨号（coord.start → outbound.start 一次，dialed=true）后再暂停/恢复。
    // 恢复时不得重连——dial() 会 cleanup 旧连接并重连，重连触发 onOnline → reconcilePeer 双向对账，
    // 等效实现收敛，会掩盖方案 A 的缺失（M6 先红门控假绿的根因）。故断言 start 只被调过 1 次。
    const outbound = makeOutbound();
    coord = new SyncCoordinator(chat, rpc as unknown as RpcServer, { debounceMs: 50, outbound });
    coord.start();          // 正常启动：拨号一次
    expect(outbound.start).toHaveBeenCalledTimes(1);
    coord.setPaused(true);  // 暂停（暂停态不补拨、不重连）
    coord.setPaused(false); // 恢复：dialed 已为 true（已拨过号），不得再调 outbound.start
    expect(outbound.start).toHaveBeenCalledTimes(1); // 仍为 1，未重连
  });
});