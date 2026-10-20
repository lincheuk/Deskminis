import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../src/minisd/store/db';
import { ChatStore } from '../src/minisd/store/chat-store';
import { RpcServer } from '../src/minisd/rpc/server';
import { startCapturedEngine, startAccessProbeEngine, accessResult, probeConnection, type CapturedEngine } from './engine-assembly';

const engines: CapturedEngine[] = [];
afterEach(async () => {
  for (const e of engines.splice(0).reverse()) await e.close();
  vi.restoreAllMocks();
});

describe('N02 置顶存储与真实 RPC', () => {

  it('秒单位、更新时间、NULL 与 onDirty：每次落库之后才通知同步', () => {
    // 用确定的时钟检查秒单位，并在 onDirty 内观察已经落库的值。
    const db = openDb(':memory:');
    let now = 1800000000000;
    try {
      const chat = new ChatStore(db, 'n02', { now: () => now });
      const s = chat.createSession();
      const notes: unknown[] = [];
      chat.onDirty = id => notes.push([id, db.prepare('SELECT pinned_at, updated_at FROM sessions WHERE id=?').get(id)]);
      now += 5000;
      chat.setPinned(s.id, true);
      expect(chat.listSessions()[0].pinnedAt).toBe(1800000005);

      // 取消置顶写 NULL，更新时间仍前进，两次通知都发生在写入之后。
      now += 1000;
      chat.setPinned(s.id, false);
      expect(chat.listSessions()[0].pinnedAt).toBeUndefined();
      expect(notes).toEqual([
        [s.id, { pinned_at: 1800000005, updated_at: 1800000005 }],
        [s.id, { pinned_at: null, updated_at: 1800000006 }]
      ]);
    } finally {
      db.close();
    }
  });

  it('已删除与冻结保留副本均拒绝写入，也不调用 onDirty', () => {
    // 真实删除和同步墓碑分别制造两种不可再写的会话。
    const db = openDb(':memory:');
    try {
      const chat = new ChatStore(db);
      const deleted = chat.createSession();
      const retained = chat.createSession();
      chat.deleteSession(deleted.id);
      chat.appendMessage({ id: 'N02-UNSEEN', sessionId: retained.id, role: 'user', parts: [], createdAt: 1, streamInterruptCount: 0 });
      chat.applyTombstone(retained.id, { v: 1, opId: 'N02-TOMB', originDeviceId: 'peer', at: 2 });
      expect(chat.listRetainedSessions().map(s => s.id)).toContain(retained.id);

      // 两种会话的置顶和取消都拒绝，失败路径不触发同步通知。
      const dirty = vi.fn();
      chat.onDirty = dirty;
      for (const id of [deleted.id, retained.id])
        for (const pinned of [true, false])
          expect(() => chat.setPinned(id, pinned)).toThrow('会话已删除');
      expect(dirty).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it('真实 RPC 校验布尔、写指定会话、成功后广播，失败不广播', async () => {
    // 真实方法表校验布尔参数，非法输入不能产生成功通知。
    const e = await startCapturedEngine();
    engines.push(e);
    const conn = probeConnection('local');
    const call = (name: string, p: unknown) => e.methods[name](p, conn);
    const s = await call('chat.sessions.create', {}) as { id: string };
    const other = await call('chat.sessions.create', {}) as { id: string };
    const broadcast = vi.spyOn(RpcServer.prototype, 'broadcast');
    for (const bad of [undefined, null, 0, 1, 'true'])
      await expect(async () => call('chat.sessions.setPinned', { sessionId: s.id, pinned: bad })).rejects.toThrow('置顶状态必须是布尔值');
    expect(broadcast).not.toHaveBeenCalled();

    // 两种合法操作只修改指定会话，成功恰好广播一次列表变更。
    for (const pinned of [true, false]) {
      broadcast.mockClear();
      expect(await call('chat.sessions.setPinned', { sessionId: s.id, pinned })).toEqual({ ok: true });
      const rows = await call('chat.sessions.list', {}) as { id: string; pinnedAt?: number }[];
      const at = rows.find(x => x.id === s.id)?.pinnedAt;
      if (pinned) {
        expect(at).toBeGreaterThan(Date.now() / 1000 - 5);
        expect(at).toBeLessThan(Date.now() / 1000 + 1);
      }
      else expect(at).toBeUndefined();
      expect(rows.find(x => x.id === other.id)?.pinnedAt).toBeUndefined();
      expect(broadcast.mock.calls).toEqual([['chat.sessions.changed', {}]]);
    }

    // 删除之后再次调用会拒绝，也不能先广播再报错。
    await call('chat.sessions.delete', { sessionId: s.id, confirm: true });
    broadcast.mockClear();
    await expect(async () => call('chat.sessions.setPinned', { sessionId: s.id, pinned: true })).rejects.toThrow('会话已删除');
    expect(broadcast).not.toHaveBeenCalled();
  }, 60000);

  it('真实访问表新的一格：与 rename 同为 business', async () => {
    // 用真实配对身份探测 local、pairing、remote 三种访问结果。
    const b = await startCapturedEngine();
    engines.push(b);
    const fp = await b.pair();
    await b.handle.close();
    const p = await startAccessProbeEngine({ dataDir: b.root });
    engines.push(p);
    const name = 'chat.sessions.setPinned';
    const row = Object.fromEntries(await Promise.all((['local', 'pairing', 'remote'] as const).map(async mode => [
      mode,
      await accessResult(p.methods[name], name, probeConnection(mode, () => {}, fp))
    ])));
    expect(row).toEqual({
      local: { allowed: true },
      pairing: { allowed: false, error: name + ' 在 pairing 模式下不可用（配对期仅可调 remote.pair.complete）' },
      remote: { allowed: true }
    });
    console.log('N02_ACCESS_ROW=' + JSON.stringify(row));
  }, 60000);
});
