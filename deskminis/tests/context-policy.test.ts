import { describe, it, expect } from 'vitest';
import { ContextPolicy, type ContextAction } from '../src/minisd/agent/context-policy';
import type { AgentMessage } from '../src/shared/types';

/** 假目录：固定窗口大小。 */
function fakeCatalog(window: number | undefined) {
  return { getModelContextWindow: () => window };
}

function msg(text: string): AgentMessage {
  return { role: 'user', parts: [{ type: 'text', value: text }] };
}

describe('ContextPolicy.estimateTokens', () => {
  it('空历史 0 token', () => {
    const p = new ContextPolicy(fakeCatalog(200_000));
    expect(p.estimateTokens([])).toBe(0);
  });

  it('粗估：parts JSON 字符数 / 4', () => {
    const p = new ContextPolicy(fakeCatalog(200_000));
    const history: AgentMessage[] = [msg('a'.repeat(400))];
    const t = p.estimateTokens(history);
    // JSON.stringify([{type:'text',value:'aaa...'}]) 长度 = 400 + 固定壳 ~22 → ~422/4 ≈ 106
    expect(t).toBe(Math.ceil((JSON.stringify(history[0].parts).length) / 4));
  });

  it('effectiveHistory 视角：只看 role+parts，没有 reasoningContent 字段可估', () => {
    // 印证签名从 RawMessage[] 改为 AgentMessage[] 的理由：reasoningContent 在
    // buildEffectiveHistory 时已被丢弃，水位估算拿不到它，所以这里也只算 parts。
    const p = new ContextPolicy(fakeCatalog(200_000));
    const history: AgentMessage[] = [{ role: 'assistant', parts: [{ type: 'text', value: 'b'.repeat(200) }] }];
    const t = p.estimateTokens(history);
    expect(t).toBe(Math.ceil(JSON.stringify(history[0].parts).length / 4));
  });
});

describe('ContextPolicy.decide', () => {
  it('未知窗口（undefined）→ 回退 128K 档：超 50% offload，超 70% compact', () => {
    const p = new ContextPolicy(fakeCatalog(undefined));
    expect(p.decide('unknown', 10_000)).toBe('none');     // < 64K (50% of 128K)
    expect(p.decide('unknown', 70_000)).toBe('offload');  // > 50% * 128K = 64000
    expect(p.decide('unknown', 95_000)).toBe('compact');  // > 70% * 128K = 89600
  });

  it('32K 窗口：超 70% offload，不 compact', () => {
    const p = new ContextPolicy(fakeCatalog(32_000));
    expect(p.decide('m', 20_000)).toBe('none');
    expect(p.decide('m', 23_000)).toBe('offload'); // > 0.7 * 32000 = 22400
  });

  it('64K 窗口：超 50% offload，超 70% compact', () => {
    const p = new ContextPolicy(fakeCatalog(64_000));
    expect(p.decide('m', 30_000)).toBe('none');
    expect(p.decide('m', 35_000)).toBe('offload'); // > 0.5 * 64000 = 32000
    expect(p.decide('m', 50_000)).toBe('compact'); // > 0.7 * 64000 = 44800
  });

  it('128K 窗口：超 50% offload，超 70% compact', () => {
    const p = new ContextPolicy(fakeCatalog(128_000));
    expect(p.decide('m', 60_000)).toBe('none');
    expect(p.decide('m', 70_000)).toBe('offload'); // > 0.5 * 128000 = 64000
    expect(p.decide('m', 95_000)).toBe('compact'); // > 0.7 * 128000 = 89600
  });

  it('200K 窗口（≥128K 档）：超 40% offload，超 60% compact', () => {
    const p = new ContextPolicy(fakeCatalog(200_000));
    expect(p.decide('m', 70_000)).toBe('none');
    expect(p.decide('m', 90_000)).toBe('offload'); // > 0.4 * 200000 = 80000
    expect(p.decide('m', 130_000)).toBe('compact'); // > 0.6 * 200000 = 120000
  });

  it('边界：正好等于阈值取更激进档', () => {
    const p = new ContextPolicy(fakeCatalog(200_000));
    expect(p.decide('m', 80_000)).toBe('offload'); // == 0.4 阈值
    expect(p.decide('m', 120_000)).toBe('compact'); // == 0.6 阈值
  });
});
