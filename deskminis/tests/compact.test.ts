import { describe, it, expect } from 'vitest';
import { CompactEngine } from '../src/minisd/agent/compact';
import { ChatStore } from '../src/minisd/store/chat-store';
import { openDb } from '../src/minisd/store/db';
import type { AgentProvider, StreamRequest } from '../src/minisd/providers/types';
import type { AgentStreamEvent, RawMessage } from '../src/shared/types';
import { ProviderError } from '../src/minisd/providers/types';

/** 脚本化假 Provider：固定返回摘要文本。 */
class SummaryProvider implements AgentProvider {
  readonly name = 'summary'; readonly modelId = 'fake';
  received: StreamRequest[] = [];
  constructor(private summaryText: string) {}
  async *streamAgentMessage(req: StreamRequest): AsyncIterable<AgentStreamEvent> {
    this.received.push(req);
    yield { kind: 'textDelta', text: this.summaryText };
    yield { kind: 'done', stopReason: 'endTurn' };
  }
}

function mkMsg(
  sessionId: string, role: 'user' | 'assistant', text: string, id: string, createdAt: number,
  parts?: RawMessage['parts'],
): RawMessage {
  return {
    id, sessionId, role,
    parts: parts ?? (text ? [{ type: 'text', value: text }] : []),
    createdAt, updatedAt: createdAt, sortOrder: 0, streamInterruptCount: 0,
  };
}

describe('CompactEngine.summarize', () => {
  it('调用 provider 生成摘要 + 写入 compact_markers', async () => {
    const store = new ChatStore(openDb(':memory:'));
    const sid = store.createSession().id;
    // 构造历史：6 个用户回合（保留最近 3 个原文，前 3 个进摘要）
    const history: RawMessage[] = [];
    for (let i = 0; i < 6; i++) {
      history.push(mkMsg(sid, 'user', `用户回合${i}`, `U${i}`, i + 1));
      history.push(mkMsg(sid, 'assistant', `助手回复${i}`, `A${i}`, i + 1.5));
    }
    const provider = new SummaryProvider('这是对话摘要');
    const engine = new CompactEngine(store);
    const marker = await engine.summarize(history, sid, provider);
    expect(marker!.summary).toBe('这是对话摘要');
    // lastCompactedMessageId 应锚定到「保留最近 3 个用户回合」之前的最后一条消息
    // 最近 3 个用户回合 = U3,U4,U5；其前一条 = A2
    expect(marker!.lastCompactedMessageId).toBe('A2');
    // marker 已落库
    const got = store.getLatestCompactMarker(sid);
    expect(got?.summary).toBe('这是对话摘要');
  });

  it('不足 3 个用户回合时不压缩：返回 undefined + 不调 provider + 不写 marker', async () => {
    const store = new ChatStore(openDb(':memory:'));
    const sid = store.createSession().id;
    const history = [mkMsg(sid, 'user', '只有一条', 'U0', 1)];
    const provider = new SummaryProvider('不该被调用');
    const engine = new CompactEngine(store);
    const marker = await engine.summarize(history, sid, provider);
    expect(marker).toBeUndefined();                 // 不写毒 marker
    expect(provider.received).toHaveLength(0);      // 不调 provider
    expect(store.getLatestCompactMarker(sid)).toBeUndefined(); // 库里仍无 marker
  });

  it('user 角色但只含 toolResult 的消息不计入「用户回合」（工具密集会话不丢真用户提问）', async () => {
    const store = new ChatStore(openDb(':memory:'));
    const sid = store.createSession().id;
    // 历史：U0(文本) A0 U1(文本) A1 U2(仅 toolResult) A2 U3(文本) A3 U4(文本) A4
    // 真正的「用户回合」= U0,U1,U3,U4 = 4 条 → 够 3 → 压缩
    // 「最近 3 个用户回合」= U1,U3,U4（按位置从后往前数 3 个真用户回合）
    // 锚点 = U1 前一条 = A0；toSummarize = [U0,A0]
    const history: RawMessage[] = [
      mkMsg(sid, 'user', '列目录', 'U0', 1),
      mkMsg(sid, 'assistant', '好', 'A0', 2),
      mkMsg(sid, 'user', '再列一次', 'U1', 3),
      mkMsg(sid, 'assistant', '', 'A1', 4, [{ type: 'toolUse', value: { toolUseId: 'T1', name: 'shell', input: '{}' } }]),
      mkMsg(sid, 'user', '', 'U2', 5, [{ type: 'toolResult', value: { toolUseId: 'T1', output: 'dir1\nfile1', success: true, status: 'success' } }]),
      mkMsg(sid, 'assistant', '完成', 'A2', 6),
      mkMsg(sid, 'user', '继续', 'U3', 7),
      mkMsg(sid, 'assistant', '好', 'A3', 8),
      mkMsg(sid, 'user', '谢谢', 'U4', 9),
      mkMsg(sid, 'assistant', '不客气', 'A4', 10),
    ];
    const provider = new SummaryProvider('摘要');
    const engine = new CompactEngine(store);
    const marker = await engine.summarize(history, sid, provider);
    expect(marker).toBeDefined();
    expect(marker!.lastCompactedMessageId).toBe('A0');   // 修复后：锚点在 U1 之前 = A0
    // 修复前（按 role==='user' 一刀切）：用户回合=U0,U1,U2,U3,U4=5，最近3=U2,U3,U4，锚点=A1 → 错误
    // 验证 toSummarize 只含 U0,A0（不含 U1——U1 保留原文）
    expect(provider.received[0].messages.map(m => m.role)).toEqual(['user', 'user', 'assistant']);
    // 第一条是 summaryPrompt（user），后两条是 U0(user)、A0(assistant)
  });

  it('provider 抛错时 summarize 透传错误且不写 marker', async () => {
    const store = new ChatStore(openDb(':memory:'));
    const sid = store.createSession().id;
    const history: RawMessage[] = [];
    for (let i = 0; i < 6; i++) { history.push(mkMsg(sid, 'user', `u${i}`, `U${i}`, i + 1)); history.push(mkMsg(sid, 'assistant', `a${i}`, `A${i}`, i + 1.5)); }
    const provider: AgentProvider = {
      name: 'fail', modelId: 'f',
      async *streamAgentMessage(): AsyncIterable<AgentStreamEvent> { throw new ProviderError('摘要失败', { status: 500 }); },
    };
    const engine = new CompactEngine(store);
    await expect(engine.summarize(history, sid, provider)).rejects.toThrow('摘要失败');
    expect(store.getLatestCompactMarker(sid)).toBeUndefined();
  });
});

describe('CompactEngine.buildEffectiveHistory', () => {
  it('无 marker: 原样返回', () => {
    const store = new ChatStore(openDb(':memory:'));
    const sid = store.createSession().id;
    const history = [mkMsg(sid, 'user', '你好', 'U0', 1), mkMsg(sid, 'assistant', '你好呀', 'A0', 2)];
    const out = new CompactEngine(store).buildEffectiveHistory(history, undefined);
    expect(out).toHaveLength(2);
    expect(out[0].role).toBe('user');
  });

  it('有 marker 且锚点存在: 摘要 + 锚点之后的消息', () => {
    const store = new ChatStore(openDb(':memory:'));
    const sid = store.createSession().id;
    const history = [
      mkMsg(sid, 'user', '旧1', 'U0', 1), mkMsg(sid, 'assistant', '旧1回复', 'A0', 2),
      mkMsg(sid, 'user', '新1', 'U1', 3), mkMsg(sid, 'assistant', '新1回复', 'A1', 4),
    ];
    const marker = { id: 'M1', sessionId: sid, summary: '旧对话摘要', lastCompactedMessageId: 'A0', createdAt: 2 };
    const out = new CompactEngine(store).buildEffectiveHistory(history, marker);
    // 摘要（user） + U1 + A1
    expect(out).toHaveLength(3);
    expect(out[0].parts[0]).toEqual({ type: 'text', value: '[对话摘要] 旧对话摘要' });
    expect(out[1].parts[0]).toEqual({ type: 'text', value: '新1' });
  });

  it('锚点丢失（id 不在 history）: 按 createdAt 自愈', () => {
    const store = new ChatStore(openDb(':memory:'));
    const sid = store.createSession().id;
    const history = [
      mkMsg(sid, 'user', '旧', 'U0', 1),
      mkMsg(sid, 'user', '新', 'U1', 5),
      mkMsg(sid, 'assistant', '新回复', 'A1', 6),
    ];
    // 锚点 id 'GONE' 不在 history；marker.createdAt = 4
    const marker = { id: 'M1', sessionId: sid, summary: '摘要', lastCompactedMessageId: 'GONE', createdAt: 4 };
    const out = new CompactEngine(store).buildEffectiveHistory(history, marker);
    // 摘要 + createdAt >= 4 的消息（U1, A1）
    expect(out).toHaveLength(3);
    expect(out[1].parts[0]).toEqual({ type: 'text', value: '新' });
  });

  it('锚点丢失且全早于 marker.createdAt: 返回摘要 + 全部历史（保守不丢内容）', () => {
    const store = new ChatStore(openDb(':memory:'));
    const sid = store.createSession().id;
    const history = [mkMsg(sid, 'user', 'x', 'U0', 1)];
    const marker = { id: 'M1', sessionId: sid, summary: '摘要', lastCompactedMessageId: 'GONE', createdAt: 100 };
    const out = new CompactEngine(store).buildEffectiveHistory(history, marker);
    expect(out).toHaveLength(2); // 摘要 + U0
    expect(out[0].parts[0]).toEqual({ type: 'text', value: '[对话摘要] 摘要' });
  });
});
