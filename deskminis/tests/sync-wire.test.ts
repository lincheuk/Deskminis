import { describe, it, expect } from 'vitest';
import { toWireMessage, toWireMarker, toWireSession, fromWireMessage, resolveWireMarker, isSyncId,
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

  it('F02 tokenUsage 的新键（缓存 / 推理 / 未报告 / 来源 / 估计 / 费用）随 JSON 原样往返；旧记录往返不多键', () => {
    const full: RawMessage['tokenUsage'] = {
      inputTokens: 4096, outputTokens: 503, cacheReadTokens: 1800, cacheWriteTokens: 248, reasoningTokens: 312,
      unreported: ['output'], v: 2,
      source: { by: 'provider', protocol: 'anthropic', modelId: 'claude-x', instanceId: 'inst-1' },
      estimate: { text: 3900, media: 1296, input: 5196 },
      cost: { status: 'unknown', reason: 'zero-price' },
    };
    const sent = toWireMessage({ ...mkMsg('M9', 'S1', 'dev', 10, 1), role: 'assistant', tokenUsage: full });
    expect(JSON.parse(sent.tokenUsageJson!)).toEqual(full);
    expect(fromWireMessage(sent).tokenUsage).toEqual(full);
    // 来源只含协议、模型 id 与配置实例 id：不把端点地址或密钥带到别的设备
    expect(Object.keys(full.source!).sort()).toEqual(['by', 'instanceId', 'modelId', 'protocol']);
    // 旧版本落下的记录：字符串原样，解析后也只有那两个键
    const legacy = toWireMessage({ ...mkMsg('M8', 'S1', 'dev', 9, 0), role: 'assistant', tokenUsage: { inputTokens: 10, outputTokens: 25 } });
    expect(legacy.tokenUsageJson).toBe('{"inputTokens":10,"outputTokens":25}');
    expect(fromWireMessage(legacy).tokenUsage).toEqual({ inputTokens: 10, outputTokens: 25 });
    // 对端（旧版本）发来的记录带着不认识的键：不丢、不报错
    const foreign = fromWireMessage({ ...sent, tokenUsageJson: '{"inputTokens":1,"outputTokens":2,"futureKey":{"a":1}}' });
    expect(foreign.tokenUsage).toEqual({ inputTokens: 1, outputTokens: 2, futureKey: { a: 1 } });
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

describe('Q12c isSyncId：消息与摘要的 id 只卡形状', () => {
  it.each([
    ['本机生成的大写 UUID', 'E7792569-25E4-432C-BC3B-A69D64B82581'], ['小写 UUID', 'e7792569-25e4-432c-bc3b-a69d64b82581'],
    ['一个字符', 'A'], ['恰好 128 个码元', 'z'.repeat(128)], ['成对的代理项', 'k😀'], ['U+FFFD 本身', 'k�'],
    ['带 NUL', 'a\u0000b'], ['带引号与反斜杠', 'x"]\\'], ['中文', '消息'], ['看起来像数字', '7.0'], ['看起来像 null', 'null'],
  ])('收：%s', (_what, id) => { expect(isSyncId(id)).toBe(true); });

  it.each([
    ['null', null], ['undefined', undefined], ['数字', 7], ['bigint', 7n], ['布尔值', true], ['对象', { id: 'A' }], ['数组', ['A']],
    ['空串', ''], ['129 个码元', 'z'.repeat(129)], ['落单的高位代理项', 'k\uD800'], ['落单的低位代理项', '\uDC00k'],
    ['次序颠倒的一对代理项', '\uDE00\uD83D'], ['高位代理项后面跟普通字符', '\uD83Dx'],
  ])('拒：%s', (_what, id) => { expect(isSyncId(id)).toBe(false); });

  it('对「含不含落单代理项」的判断与运行时的 isWellFormed 一致', () => {
    const wellFormed = (s: string): boolean => (s as unknown as { isWellFormed(): boolean }).isWellFormed();
    const units = ['a', '\uD800', '\uDBFF', '\uDC00', '\uDFFF', '�', '\u0000'];
    for (const x of units) for (const y of units) for (const z of units) {
      const s = x + y + z;
      expect(isSyncId(s), JSON.stringify(s)).toBe(wellFormed(s));
    }
  });
});
