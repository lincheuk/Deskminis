import { describe, it, expect } from 'vitest';
import { pruneOldToolResults } from '../src/minisd/agent/prune';
import type { AgentMessage } from '../src/shared/types';

/** 构造一条 toolResult 消息（output 长度可调）。 */
function tr(output: string, toolUseId = 'T1'): AgentMessage {
  return { role: 'user', parts: [{ type: 'toolResult', value: { toolUseId, output, success: true, status: 'success' } }] };
}
const text = (v: string): AgentMessage => ({ role: 'user', parts: [{ type: 'text', value: v }] });

describe('pruneOldToolResults', () => {
  it('只修剪「最近 keepRecentMessages 条之前」且超过 minChars 的旧 toolResult', () => {
    // 16 条历史：idx 0-3 是旧区（len-12=4），其中两条超阈值、一条短、一条文本
    const big = 'B'.repeat(3000);
    const history: AgentMessage[] = [
      tr(big, 'T_old_big'),       // 旧且超阈值 → 修剪
      tr('short', 'T_old_small'), // 旧但短 → 不动
      text('旧文本'),              // 非 toolResult → 不动
      tr(big, 'T_old_big2'),      // 旧且超阈值 → 修剪
      ...Array.from({ length: 12 }, (_, i) => tr(big, `T_new_${i}`)), // 最近 12 条 → 不动
    ];
    const { pruned, history: out } = pruneOldToolResults(history);
    expect(pruned).toBe(2);
    // 被修剪的两条是桩文本（含原长度）
    const oldBig = out[0].parts[0] as { type: 'toolResult'; value: { output: string } };
    expect(oldBig.value.output).toContain('已修剪');
    expect(oldBig.value.output).toContain('原 3000 字符');
    expect((out[3].parts[0] as { value: { output: string } }).value.output).toContain('已修剪');
    // 其余原样（引用相等）
    expect(out[1]).toBe(history[1]);
    expect(out[2]).toBe(history[2]);
    for (let i = 4; i < 16; i++) expect(out[i]).toBe(history[i]);
  });

  it('默认阈值：keepRecentMessages=12、minChars=2000', () => {
    // 13 条：idx 0 是旧大输出（len-12=1 → idx 0 纳入修剪范围），最近 12 条小输出不动
    const history: AgentMessage[] = [tr('B'.repeat(2500)), ...Array.from({ length: 12 }, () => tr('short'))];
    const { pruned, history: out } = pruneOldToolResults(history);
    expect(pruned).toBe(1);
    expect((out[0].parts[0] as { value: { output: string } }).value.output).toContain('已修剪');
    for (let i = 1; i < 13; i++) expect(out[i]).toBe(history[i]);
  });

  it('入参不被修改（纯函数）', () => {
    const history: AgentMessage[] = [tr('B'.repeat(3000)), tr('short'), text('x')];
    const snapshot = JSON.stringify(history);
    pruneOldToolResults(history);
    expect(JSON.stringify(history)).toBe(snapshot);
  });

  it('返回计数正确：多条超阈值大输出逐条计数', () => {
    const history: AgentMessage[] = [
      tr('B'.repeat(2500), 'T0'),
      tr('B'.repeat(2500), 'T1'),
      ...Array.from({ length: 12 }, () => tr('x')),
    ];
    const { pruned } = pruneOldToolResults(history);
    expect(pruned).toBe(2);
  });
});
