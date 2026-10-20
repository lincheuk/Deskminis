/**
 * F05 Q 组：请求侧配对（pairToolResults）的相邻规则。
 *
 * 一条 toolResult 只有紧跟在「声明了它的那条 assistant」后面才进请求；被别的消息隔开的、跟错了 assistant 的、
 * 同一批分在两条消息里的后一条，都不进请求，缺的结果由占位补齐。
 * 触发场景：恢复补写的结果消息（时间是恢复时刻）与对应的 assistant 之间，被之后同步合并进来的另一台设备的消息隔开——
 * 以前这样的会话每次请求都会被服务商以 400 拒绝（同一个 id 两份结果，其中一份不跟在带它的 assistant 后面）。
 *
 * 纯函数用例：只引 pairToolResults 与 assertPaired。
 */
import { describe, it, expect } from 'vitest';
import type { AgentMessage, ContentPart } from '../src/shared/types';
import { pairToolResults } from '../src/minisd/agent/loop';
import { assertPaired } from './run-ledger-fixture';

const text = (v: string): ContentPart => ({ type: 'text', value: v });
const use = (id: string): ContentPart => ({ type: 'toolUse', value: { toolUseId: id, name: 'file_write', input: '{}' } });
const result = (id: string, output = `${id} 的真实结果`): ContentPart =>
  ({ type: 'toolResult', value: { toolUseId: id, output, success: true, status: 'success' } });
const user = (...parts: ContentPart[]): AgentMessage => ({ role: 'user', parts });
const assistant = (...parts: ContentPart[]): AgentMessage => ({ role: 'assistant', parts });

const resultsOf = (m: AgentMessage): { toolUseId: string; output: string }[] =>
  m.parts.filter(p => p.type === 'toolResult').map(p => p.value as { toolUseId: string; output: string });
const allResults = (ms: AgentMessage[], id: string): { toolUseId: string; output: string }[] =>
  ms.flatMap(resultsOf).filter(r => r.toolUseId === id);
const PLACEHOLDER = '[工具执行被中断，结果未知]';

describe('F05 pairToolResults：只认紧跟对应 assistant 的结果', () => {
  it('Q1 结果被别的消息隔在后面：不进请求，那次调用只有紧跟它的一份占位', () => {
    const input = [
      user(text('开始')),
      assistant(use('T1')),
      user(text('另一台设备上接着说的话')),
      assistant(text('另一台设备上的回复')),
      user(result('T1')),
    ];
    const out = pairToolResults(input);
    expect(() => assertPaired(out)).not.toThrow();
    // T1 恰好一份结果（占位），紧跟带 T1 的 assistant
    expect(allResults(out, 'T1')).toHaveLength(1);
    expect(out[1]).toBe(input[1]);
    expect(resultsOf(out[2]).map(r => r.output)).toEqual([PLACEHOLDER]);
    // 被隔开的那份真实结果不在请求里
    expect(resultsOf(out[out.length - 1])).toEqual([]);
    expect(JSON.stringify(out)).not.toContain('T1 的真实结果');
  });

  it('Q2 并入占位时下一条里是别的 assistant 的结果：不把它留在这条 assistant 后面', () => {
    const input = [
      user(text('开始')),
      assistant(use('T1')),
      user(text('插进来的话')),
      assistant(use('T5')),
      user(result('T1')),
    ];
    const out = pairToolResults(input);
    expect(() => assertPaired(out)).not.toThrow();
    // 带 T5 的 assistant 后面只有 T5 的占位
    const at = out.findIndex(m => m.role === 'assistant' && m.parts.some(p => p.type === 'toolUse' && (p.value as { toolUseId: string }).toolUseId === 'T5'));
    expect(resultsOf(out[at + 1])).toEqual([expect.objectContaining({ toolUseId: 'T5', output: PLACEHOLDER })]);
    expect(allResults(out, 'T1').map(r => r.output)).toEqual([PLACEHOLDER]);
  });

  it('Q3 同一批的结果分在连续两条消息里：后一条里的不与占位重复', () => {
    const input = [
      user(text('开始')),
      assistant(use('T1'), use('T2')),
      user(result('T1')),
      user(result('T2')),
    ];
    const out = pairToolResults(input);
    expect(() => assertPaired(out)).not.toThrow();
    expect(allResults(out, 'T2')).toHaveLength(1);
    expect(allResults(out, 'T1').map(r => r.output)).toEqual(['T1 的真实结果']);
  });

  it('Q4 多批都正确配对的长历史：逐条原样返回（同一引用，没有多余拷贝）', () => {
    const input = [
      user(text('开始')),
      assistant(text('先读'), use('A1'), use('A2')),
      user(result('A1'), result('A2')),
      assistant(use('B1')),
      user(result('B1'), text('顺便说一句')),
      assistant(text('好')),
      user(text('继续')),
      assistant(use('C1')),
      user(result('C1')),
      assistant(text('完成')),
    ];
    const out = pairToolResults(input);
    expect(out).toHaveLength(input.length);
    out.forEach((m, i) => expect(m).toBe(input[i]));
    expect(() => assertPaired(out)).not.toThrow();
  });

  it('Q5 一条 assistant 里同一个 toolUseId 出现两次、下一条里两份结果：两份都保留', () => {
    const input = [
      user(text('开始')),
      assistant(use('D1'), use('D1')),
      user(result('D1', '第一份'), result('D1', '第二份')),
    ];
    const out = pairToolResults(input);
    expect(out[2]).toBe(input[2]);
    expect(allResults(out, 'D1').map(r => r.output)).toEqual(['第一份', '第二份']);
    expect(() => assertPaired(out)).not.toThrow();
  });
});

describe('assertPaired 自检（断言工具本身分得清好坏）', () => {
  it('游离的、重复的、缺失的结果都报错；正确配对不报', () => {
    expect(() => assertPaired([user(text('a')), assistant(use('X')), user(result('X'))])).not.toThrow();
    expect(() => assertPaired([user(text('a')), assistant(use('X')), user(text('没有结果'))])).toThrow(/对不上/);
    expect(() => assertPaired([user(text('a')), assistant(use('X'))])).toThrow(/没有结果消息/);
    expect(() => assertPaired([user(result('X'))])).toThrow(/紧邻的不是/);
    expect(() => assertPaired([user(text('a')), assistant(use('X')), user(result('X')), user(result('X'))])).toThrow(/紧邻的不是/);
    expect(() => assertPaired([user(text('a')), assistant(use('X')), assistant(text('b'))])).toThrow(/没有紧跟结果消息/);
    expect(() => assertPaired([user(text('a')), assistant(use('X')), user(text('先说话'), result('X'))])).toThrow(/没有全部排在开头/);
  });
});
