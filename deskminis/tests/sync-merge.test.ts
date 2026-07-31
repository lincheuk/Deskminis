import { describe, it, expect } from 'vitest';
import { mergeSession } from '../src/minisd/sync/merge';
import { toWireMessage, type WireMessage, type WireCompactMarker } from '../src/minisd/sync/wire';
import type { RawMessage } from '../src/shared/types';

function mkMsg(id: string, sid: string, origin: string, localTs: number, sortOrder: number): RawMessage {
  return {
    id, sessionId: sid, role: 'user', parts: [{ type: 'text', value: 'x' }],
    createdAt: localTs, updatedAt: localTs, sortOrder, streamInterruptCount: 0,
    originDeviceId: origin, createdLocallyAt: localTs,
  };
}
function toWire(m: RawMessage): WireMessage { return toWireMessage(m); }

describe('mergeSession 三路去重', () => {
  it('local 与 remote 各有不同 id → 合并后全部出现', () => {
    const sid = 'S1';
    const local = { messages: [mkMsg('A', sid, 'me', 1.0, 0)], markers: [] };
    const remote = { messages: [toWire(mkMsg('B', sid, 'phone', 2.0, 0))], markers: [] };
    const r = mergeSession(local, remote);
    expect(r.messages.map(m => m.id).sort()).toEqual(['A', 'B']);
  });

  it('id 重复 → 保留 local（信任本端已落库）', () => {
    const sid = 'S1';
    const local = { messages: [mkMsg('A', sid, 'me', 1.0, 0)], markers: [] };
    // 同 id 不同 origin（理论不会发生，但容错）
    const remoteMsg = { ...toWire(mkMsg('A', sid, 'phone', 2.0, 5)) };
    const remote = { messages: [remoteMsg], markers: [] };
    const r = mergeSession(local, remote);
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0].originDeviceId).toBe('me'); // local 胜
  });
});

describe('mergeSession k 路归并（评审命门 1）', () => {
  it('同一 originDeviceId 内按 createdLocallyAt 升序（流内单调）', () => {
    const sid = 'S1';
    // 故意乱序输入
    const local = { messages: [mkMsg('B', sid, 'me', 2.0, 1), mkMsg('A', sid, 'me', 1.0, 0)], markers: [] };
    const remote = { messages: [], markers: [] };
    const r = mergeSession(local, remote);
    expect(r.messages.map(m => m.id)).toEqual(['A', 'B']);
  });

  it('跨端时序交错：桌面 1-3 → 手机 4-6 → 桌面 7-9 → 交错排列（非字典序两大块）', () => {
    const sid = 'S1';
    // 桌面 ts=1,2,3,7,8,9；手机 ts=4,5,6（手机离线期 ts 在桌面之后、桌面恢复前）
    // 期望 k 路归并按 createdLocallyAt 交错：1,2,3,4,5,6,7,8,9
    // ——旧「字典序主导」会把桌面 7,8,9 排到手机 4,5,6 前面，错
    const local = {
      messages: [
        mkMsg('D1', sid, 'desk', 1.0, 0), mkMsg('D2', sid, 'desk', 2.0, 1), mkMsg('D3', sid, 'desk', 3.0, 2),
        mkMsg('D4', sid, 'desk', 7.0, 3), mkMsg('D5', sid, 'desk', 8.0, 4), mkMsg('D6', sid, 'desk', 9.0, 5),
      ],
      markers: [],
    };
    const remote = {
      messages: [
        toWire(mkMsg('P1', sid, 'phone', 4.0, 0)),
        toWire(mkMsg('P2', sid, 'phone', 5.0, 1)),
        toWire(mkMsg('P3', sid, 'phone', 6.0, 2)),
      ],
      markers: [],
    };
    const r = mergeSession(local, remote);
    expect(r.messages.map(m => m.id)).toEqual(['D1','D2','D3','P1','P2','P3','D4','D5','D6']);
  });

  it('跨端平局：同 createdLocallyAt 用 (originDeviceId 字典序, id) 决出确定性', () => {
    const sid = 'S1';
    // desk 与 phone 同 ts=5.0，desk 字典序在前
    const local = { messages: [mkMsg('D', sid, 'desk', 5.0, 0)], markers: [] };
    const remote = { messages: [toWire(mkMsg('P', sid, 'phone', 5.0, 0))], markers: [] };
    const r = mergeSession(local, remote);
    expect(r.messages.map(m => m.id)).toEqual(['D', 'P']);
  });

  it('两端独立调用 mergeSession 结果逐位一致（评审命门 1 验收红线）', () => {
    const sid = 'S1';
    // 桌面视角：local=desk 消息 + remote=phone wire
    const deskLocal = {
      messages: [
        mkMsg('D1', sid, 'desk', 1.0, 0), mkMsg('D2', sid, 'desk', 3.0, 1), mkMsg('D3', sid, 'desk', 5.0, 2),
      ],
      markers: [],
    };
    const phoneWire = {
      messages: [
        toWire(mkMsg('P1', sid, 'phone', 2.0, 0)),
        toWire(mkMsg('P2', sid, 'phone', 4.0, 1)),
      ],
      markers: [],
    };
    const fromDesk = mergeSession(deskLocal, phoneWire).messages.map(m => m.id);
    // 手机视角：local=phone 消息 + remote=desk wire（toWire 转换）
    const phoneLocal = {
      messages: [
        mkMsg('P1', sid, 'phone', 2.0, 0), mkMsg('P2', sid, 'phone', 4.0, 1),
      ],
      markers: [],
    };
    const deskWire = {
      messages: [
        toWire(mkMsg('D1', sid, 'desk', 1.0, 0)),
        toWire(mkMsg('D2', sid, 'desk', 3.0, 1)),
        toWire(mkMsg('D3', sid, 'desk', 5.0, 2)),
      ],
      markers: [],
    };
    const fromPhone = mergeSession(phoneLocal, deskWire).messages.map(m => m.id);
    expect(fromDesk).toEqual(fromPhone);
    expect(fromDesk).toEqual(['D1','P1','D2','P2','D3']);
  });

  it('sortOrder 按 mergedMessages 顺序重排（0,1,2,...）', () => {
    const sid = 'S1';
    const local = { messages: [mkMsg('A', sid, 'me', 1.0, 5), mkMsg('B', sid, 'me', 2.0, 3)], markers: [] };
    const remote = { messages: [toWire(mkMsg('C', sid, 'phone', 100.0, 99))], markers: [] };
    const r = mergeSession(local, remote);
    expect(r.messages.map(m => m.sortOrder)).toEqual([0, 1, 2]);
  });
});

describe('mergeSession marker LWW', () => {
  it('两端 marker id 不同 → 全部保留', () => {
    const sid = 'S1';
    const local = { messages: [mkMsg('A', sid, 'me', 1.0, 0)], markers: [{ id: 'MK1', sessionId: sid, summary: '旧', lastCompactedMessageId: 'A', createdAt: 100.0 }] };
    const remote = { messages: [], markers: [{ id: 'MK2', sessionId: sid, summary: '新', lastCompactedMessageId: 'A', createdAt: 200.0, firstKeptSortOrder: 1, compactedCount: 1, version: 2 } as WireCompactMarker] };
    const r = mergeSession(local, remote);
    expect(r.markers).toHaveLength(2);
  });

  it('marker id 重复 → createdAt 较晚者胜', () => {
    const sid = 'S1';
    const local = { messages: [mkMsg('A', sid, 'me', 1.0, 0)], markers: [{ id: 'MK', sessionId: sid, summary: 'local旧', lastCompactedMessageId: 'A', createdAt: 100.0 }] };
    const remote = { messages: [], markers: [{ id: 'MK', sessionId: sid, summary: 'remote新', lastCompactedMessageId: 'A', createdAt: 200.0, firstKeptSortOrder: 1, compactedCount: 1, version: 2 } as WireCompactMarker] };
    const r = mergeSession(local, remote);
    expect(r.markers).toHaveLength(1);
    expect(r.markers[0].summary).toBe('remote新');
  });

  it('marker 同 createdAt 同 id → local 优先（避免远端覆盖本端刚落的）', () => {
    const sid = 'S1';
    const local = { messages: [mkMsg('A', sid, 'me', 1.0, 0)], markers: [{ id: 'MK', sessionId: sid, summary: 'local', lastCompactedMessageId: 'A', createdAt: 100.0 }] };
    const remote = { messages: [], markers: [{ id: 'MK', sessionId: sid, summary: 'remote', lastCompactedMessageId: 'A', createdAt: 100.0, firstKeptSortOrder: 1, compactedCount: 1, version: 2 } as WireCompactMarker] };
    const r = mergeSession(local, remote);
    expect(r.markers[0].summary).toBe('local');
  });
});

describe('mergeSession 锚换算时序（§4.4）', () => {
  it('remote marker 只带 firstKeptMessageId → 在合并序列上回算 lastCompactedMessageId', () => {
    const sid = 'S1';
    const local = { messages: [mkMsg('A', sid, 'me', 1.0, 0), mkMsg('B', sid, 'me', 2.0, 1), mkMsg('C', sid, 'me', 3.0, 2)], markers: [] };
    const remote = {
      messages: [],
      markers: [{
        id: 'MK', sessionId: sid, summary: 'phone压缩', createdAt: 200.0,
        lastCompactedMessageId: undefined, firstKeptMessageId: 'C',
        firstKeptSortOrder: 2, compactedCount: 2, version: 2,
      } as WireCompactMarker],
    };
    const r = mergeSession(local, remote);
    expect(r.markers).toHaveLength(1);
    expect(r.markers[0].lastCompactedMessageId).toBe('B'); // C 的前一条
    expect(r.orphanMarkerIds).toEqual([]);
  });

  it('remote marker firstKeptMessageId 在 mergedMessages 首条 → orphan', () => {
    const sid = 'S1';
    const local = { messages: [mkMsg('A', sid, 'me', 1.0, 0)], markers: [] };
    const remote = {
      messages: [],
      markers: [{
        id: 'MK', sessionId: sid, summary: 'phone压缩', createdAt: 200.0,
        lastCompactedMessageId: undefined, firstKeptMessageId: 'A',
        firstKeptSortOrder: 0, compactedCount: 0, version: 2,
      } as WireCompactMarker],
    };
    const r = mergeSession(local, remote);
    expect(r.orphanMarkerIds).toEqual(['MK']);
    // orphan marker 仍返回（mergeRemoteSession 据此落 sync_orphan_markers，不落 compact_markers）
    expect(r.markers.map(m => m.id)).toContain('MK');
  });

  it('orphan marker 脱孤：补齐缺失消息后 next mergeSession 不再标 orphan', () => {
    const sid = 'S1';
    // 第一次合并：A 在 local，phone marker firstKeptMessageId='B'（B 不在 mergedMessages）→ orphan
    const local1 = { messages: [mkMsg('A', sid, 'me', 1.0, 0)], markers: [] };
    const remote1 = {
      messages: [],
      markers: [{
        id: 'MK', sessionId: sid, summary: 'phone压缩', createdAt: 200.0,
        lastCompactedMessageId: undefined, firstKeptMessageId: 'B',
        firstKeptSortOrder: 1, compactedCount: 1, version: 2,
      } as WireCompactMarker],
    };
    const r1 = mergeSession(local1, remote1);
    expect(r1.orphanMarkerIds).toEqual(['MK']);

    // 第二次合并：B 已补齐到 local（模拟 sync.pull 拿到了 B）
    const local2 = { messages: [mkMsg('A', sid, 'me', 1.0, 0), mkMsg('B', sid, 'me', 2.0, 1)], markers: [] };
    const remote2 = remote1; // 同一 marker wire
    const r2 = mergeSession(local2, remote2);
    expect(r2.orphanMarkerIds).toEqual([]);
    expect(r2.markers[0].lastCompactedMessageId).toBe('A'); // B 的前一条
  });
});

describe('mergeSession 单次 O(N) 复杂度（用例覆盖，非真实测时）', () => {
  it('100 条消息两端各 50 → 合并 100 条，sortOrder 0-99', () => {
    const sid = 'S1';
    const localMsgs = Array.from({ length: 50 }, (_, i) => mkMsg(`L${i}`, sid, 'me', i, i));
    const remoteMsgs = Array.from({ length: 50 }, (_, i) => toWire(mkMsg(`R${i}`, sid, 'phone', 100 + i, i)));
    const r = mergeSession({ messages: localMsgs, markers: [] }, { messages: remoteMsgs, markers: [] });
    expect(r.messages).toHaveLength(100);
    expect(r.messages.map(m => m.sortOrder)).toEqual(Array.from({ length: 100 }, (_, i) => i));
  });
});
