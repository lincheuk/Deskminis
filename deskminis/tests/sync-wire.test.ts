import { describe, it, expect } from 'vitest';
import { toWireMessage, toWireMarker, toWireSession, fromWireMessage, resolveWireMarker,
  type WireMessage, type WireCompactMarker, type WireSession } from '../src/minisd/sync/wire';
import type { RawMessage, CompactMarker, SessionMeta } from '../src/shared/types';

function mkMsg(id: string, sid: string, origin: string, localTs: number, sortOrder: number): RawMessage {
  return {
    id, sessionId: sid, role: 'user', parts: [{ type: 'text', value: 'x' }],
    createdAt: localTs, updatedAt: localTs, sortOrder, streamInterruptCount: 0,
    originDeviceId: origin, createdLocallyAt: localTs,
  };
}

describe('WireMessage 字段对齐 OM SyncedMessage', () => {
  it('toWireMessage 输出 id/sessionId/role/partsJson/originDeviceId/createdLocallyAt 等字段', () => {
    const m = mkMsg('M1', 'S1', 'me', 1000.0, 0);
    const w = toWireMessage(m);
    expect(w.id).toBe('M1');
    expect(w.sessionId).toBe('S1');
    expect(w.role).toBe('user');
    expect(w.partsJson).toBe(JSON.stringify([{ type: 'text', value: 'x' }]));
    expect(w.originDeviceId).toBe('me');
    expect(w.createdLocallyAt).toBe(1000.0);
    expect(w.streamInterruptCount).toBe(0);
    expect(typeof w.sortOrder).toBe('number'); // best-effort hint
  });

  it('fromWireMessage 还原为本地 RawMessage 输入（不含 sortOrder/updatedAt）', () => {
    const w: WireMessage = {
      id: 'W1', sessionId: 'S1', role: 'assistant', partsJson: '[]',
      tokenUsageJson: null, reasoningContent: null, streamInterruptCount: 0,
      sortOrder: 5, createdAt: 2000.0, updatedAt: 2000.0,
      originDeviceId: 'phone', createdLocallyAt: 1999.0,
    };
    const r = fromWireMessage(w);
    expect(r.id).toBe('W1');
    expect(r.role).toBe('assistant');
    expect(r.originDeviceId).toBe('phone');
    expect(r.createdLocallyAt).toBe(1999.0);
    expect((r as any).sortOrder).toBeUndefined();
    expect((r as any).updatedAt).toBeUndefined();
  });
});

describe('WireCompactMarker 双锚齐备', () => {
  it('toWireMarker 出口：lastCompactedMessageId 主锚 + firstKeptSortOrder/firstKeptMessageId 辅锚按本地序回填', () => {
    const sid = 'S1';
    const msgs = [mkMsg('A', sid, 'me', 1.0, 0), mkMsg('B', sid, 'me', 2.0, 1), mkMsg('C', sid, 'me', 3.0, 2)];
    const marker: CompactMarker = { id: 'MK1', sessionId: sid, summary: '摘要', lastCompactedMessageId: 'B', createdAt: 100.0 };
    const w = toWireMarker(marker, msgs);
    expect(w.id).toBe('MK1');
    expect(w.lastCompactedMessageId).toBe('B');
    expect(w.firstKeptMessageId).toBe('C'); // B 的下一条
    expect(w.firstKeptSortOrder).toBe(2);   // C 的 sortOrder
    expect(w.compactedCount).toBe(2);        // A, B 两条被压缩
    expect(w.version).toBe(2);
  });

  it('toWireMarker 锚=末条消息：firstKeptMessageId=undefined, firstKeptSortOrder=lastSortOrder+1', () => {
    const sid = 'S1';
    const msgs = [mkMsg('A', sid, 'me', 1.0, 0), mkMsg('B', sid, 'me', 2.0, 1)];
    const marker: CompactMarker = { id: 'MK2', sessionId: sid, summary: '摘要', lastCompactedMessageId: 'B', createdAt: 100.0 };
    const w = toWireMarker(marker, msgs);
    expect(w.firstKeptMessageId).toBeUndefined();
    expect(w.firstKeptSortOrder).toBe(2); // B.sortOrder(1) + 1
  });

  it('resolveWireMarker 入口：优先取 lastCompactedMessageId', () => {
    const merged = [mkMsg('A', 'S', 'me', 1.0, 0), mkMsg('B', 'S', 'me', 2.0, 1)];
    const w: WireCompactMarker = {
      id: 'MK', sessionId: 'S', summary: 'x', createdAt: 100.0,
      lastCompactedMessageId: 'B', firstKeptSortOrder: 2, compactedCount: 2, version: 2,
    };
    const r = resolveWireMarker(w, merged);
    expect(r.isOrphan).toBe(false);
    expect(r.marker.lastCompactedMessageId).toBe('B');
  });

  it('resolveWireMarker 入口：lastCompactedMessageId 缺失 → firstKeptMessageId 在合并序列回算（§4.4 时序）', () => {
    const merged = [mkMsg('A', 'S', 'me', 1.0, 0), mkMsg('B', 'S', 'me', 2.0, 1), mkMsg('C', 'S', 'me', 3.0, 2)];
    const w: WireCompactMarker = {
      id: 'MK', sessionId: 'S', summary: 'x', createdAt: 100.0,
      lastCompactedMessageId: undefined,
      firstKeptMessageId: 'C', firstKeptSortOrder: 2, compactedCount: 2, version: 2,
    };
    const r = resolveWireMarker(w, merged);
    expect(r.isOrphan).toBe(false);
    expect(r.marker.lastCompactedMessageId).toBe('B'); // C 的前一条
  });

  it('resolveWireMarker 入口：firstKeptMessageId 是合并序列首条 → orphan', () => {
    const merged = [mkMsg('A', 'S', 'me', 1.0, 0), mkMsg('B', 'S', 'me', 2.0, 1)];
    const w: WireCompactMarker = {
      id: 'MK', sessionId: 'S', summary: 'x', createdAt: 100.0,
      lastCompactedMessageId: undefined,
      firstKeptMessageId: 'A', firstKeptSortOrder: 0, compactedCount: 0, version: 2,
    };
    const r = resolveWireMarker(w, merged);
    expect(r.isOrphan).toBe(true);
  });

  it('resolveWireMarker 入口：firstKeptMessageId 不在合并序列 → orphan', () => {
    const merged = [mkMsg('A', 'S', 'me', 1.0, 0)];
    const w: WireCompactMarker = {
      id: 'MK', sessionId: 'S', summary: 'x', createdAt: 100.0,
      lastCompactedMessageId: undefined,
      firstKeptMessageId: 'MISSING', firstKeptSortOrder: 0, compactedCount: 0, version: 2,
    };
    const r = resolveWireMarker(w, merged);
    expect(r.isOrphan).toBe(true);
  });

  it('resolveWireMarker 两锚都缺 → firstKeptSortOrder 按 sortOrder 回算（legacy v1 链）', () => {
    const merged = [mkMsg('A', 'S', 'me', 1.0, 0), mkMsg('B', 'S', 'me', 2.0, 1), mkMsg('C', 'S', 'me', 3.0, 2)];
    const w: WireCompactMarker = {
      id: 'MK', sessionId: 'S', summary: 'x', createdAt: 100.0,
      lastCompactedMessageId: undefined, firstKeptMessageId: undefined,
      firstKeptSortOrder: 2, compactedCount: 2, version: 1,
    };
    const r = resolveWireMarker(w, merged);
    expect(r.isOrphan).toBe(false);
    expect(r.marker.lastCompactedMessageId).toBe('B'); // sortOrder=2 的前一条
  });
});

describe('WireSession 字段对齐 OM SyncedSession', () => {
  it('toWireSession 输出 id/title/createdAt/updatedAt/memoryEnabled/modelBinding/pinnedAt', () => {
    const s: SessionMeta = { id: 'S1', title: '测试', createdAt: 1.0, updatedAt: 2.0, memoryEnabled: true, modelBinding: 'provider:abc', pinnedAt: 3.0 };
    const w = toWireSession(s);
    expect(w.id).toBe('S1');
    expect(w.title).toBe('测试');
    expect(w.createdAt).toBe(1.0);
    expect(w.updatedAt).toBe(2.0);
    expect(w.memoryEnabled).toBe(1);
    expect(w.modelBinding).toBe('provider:abc');
    expect(w.pinnedAt).toBe(3.0);
  });
});
