/**
 * F02 验收 2 / 阻断 2：三种 adapter 的真实格式 usage（缓存命中、缺字段、流式更新、重复事件），验证不重复计数、不丢维度。
 * 真 adapter + 注入的 fetch 回放 SSE 帧；夹具与出处见 tests/usage-fixtures.ts（形状取自官方文档，没有真实调用）。
 */
import { describe, expect, it } from 'vitest';
import { AnthropicProvider } from '../src/minisd/providers/anthropic';
import { OpenAIProvider } from '../src/minisd/providers/openai';
import { GeminiProvider } from '../src/minisd/providers/gemini';
import type { AgentProvider, StreamRequest } from '../src/minisd/providers/types';
import type { AgentStreamEvent, TokenUsage } from '../src/shared/types';
import * as F from './usage-fixtures';

const REQ: StreamRequest = { messages: [{ role: 'user', parts: [{ type: 'text', value: 'hi' }] }], tools: [], maxTokens: 100, thinkingLevel: 'off' };
const respond = (text: string) => async (): Promise<Response> => new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });

async function drain(p: AgentProvider): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = [];
  for await (const e of p.streamAgentMessage(REQ)) events.push(e);
  return events;
}
const anthropic = (frames: F.Frame[]) => drain(new AnthropicProvider({ apiKey: 'k', modelId: 'm', fetchImpl: respond(F.anthropicSse(frames)) }));
const openai = (frames: F.Frame[], done = true) => drain(new OpenAIProvider({ apiKey: 'k', modelId: 'm', baseUrl: 'http://x/v1', fetchImpl: respond(F.openaiSse(frames, done)) }));
const gemini = (frames: F.Frame[]) => drain(new GeminiProvider({ apiKey: 'k', modelId: 'gem', fetchImpl: respond(F.geminiSse(frames)) }));

/** 流里的 usage 事件（应当至多一条）。 */
const usagesOf = (events: AgentStreamEvent[]): TokenUsage[] => events.flatMap(e => e.kind === 'usage' ? [e.usage] : []);
/** 恰好一条 usage 事件，返回它。 */
function usageOf(events: AgentStreamEvent[]): TokenUsage {
  const all = usagesOf(events);
  expect(all).toHaveLength(1);
  return all[0];
}

describe('Anthropic usage 归一化', () => {
  it('UA1 基本示例：message_start 与 message_delta 不相加，事件没有多余的键', async () => {
    expect(usageOf(await anthropic(F.UA1_BASIC))).toEqual({ inputTokens: 25, outputTokens: 15 });
  });
  it('UA2 缓存命中：总输入 = 未缓存 + 缓存读取 + 缓存写入，cache_creation 拆分对象不再加一遍', async () => {
    expect(usageOf(await anthropic(F.UA2_CACHE))).toEqual({ inputTokens: 4096, cacheReadTokens: 1800, cacheWriteTokens: 248, outputTokens: 503 });
  });
  it('UA3 message_delta 重报更大的累计输入：取累计值，不与 message_start 相加', async () => {
    expect(usageOf(await anthropic(F.UA3_CUMULATIVE))).toEqual({ inputTokens: 10682, outputTokens: 510, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });
  it('UA4 重复事件与累计更新是幂等的', async () => {
    const want = { inputTokens: 25, outputTokens: 15 };
    expect(usageOf(await anthropic(F.UA4_DUP_DELTA))).toEqual(want);
    expect(usageOf(await anthropic(F.UA4_DUP_START))).toEqual(want);
    expect(usageOf(await anthropic(F.UA4_TWO_DELTAS))).toEqual(want);
  });
  it('UA5 两个事件都不带 usage：不发 usage 事件（不是 0/0），done 仍在', async () => {
    const events = await anthropic(F.UA5_NO_USAGE);
    expect(usagesOf(events)).toEqual([]);
    expect(events.at(-1)).toEqual({ kind: 'done', stopReason: 'endTurn' });
  });
  it('UA6 只报了输入：输出写 0 并标为未报告', async () => {
    expect(usageOf(await anthropic(F.UA6_NO_OUTPUT))).toEqual({ inputTokens: 5, outputTokens: 0, unreported: ['output'] });
  });
  it('UA7 thinking_tokens 是输出的子集：不加进输出，也不丢', async () => {
    expect(usageOf(await anthropic(F.UA7_THINKING))).toEqual({ inputTokens: 40, outputTokens: 348, reasoningTokens: 312 });
  });
  it('UA8 子维度越界则丢掉；非法值当没出现', async () => {
    expect(usageOf(await anthropic(F.UA8_THINKING_OVER))).toEqual({ inputTokens: 40, outputTokens: 100 });
    expect(usageOf(await anthropic(F.UA8_INVALID))).toEqual({ inputTokens: 40, outputTokens: 100 });
  });
  it('UA9 中转在某一个事件里把 input_tokens 补成 0：两种方向都不丢真实输入', async () => {
    expect(usageOf(await anthropic(F.UA9_DELTA_ZERO))).toEqual({ inputTokens: 1200, outputTokens: 40 });
    expect(usageOf(await anthropic(F.UA9_START_ZERO))).toEqual({ inputTokens: 1200, outputTokens: 40 });
  });
});

describe('OpenAI 兼容 usage 归一化', () => {
  it('UO1 末帧 choices:[] 带明细：明细是总数的子集，null 不覆盖结果', async () => {
    expect(usageOf(await openai(F.UO1_FINAL_CHUNK))).toEqual({ inputTokens: 1000, outputTokens: 300, cacheReadTokens: 800, cacheWriteTokens: 100, reasoningTokens: 120 });
  });
  it('UO2 DeepSeek 的 prompt_cache_hit_tokens 认作缓存读取，hit + miss 不再加到 prompt 上', async () => {
    expect(usageOf(await openai(F.UO2_DEEPSEEK))).toEqual({ inputTokens: 1000, outputTokens: 50, cacheReadTokens: 700 });
  });
  it('UO3 每帧都带累计 usage：取最后一帧，不累加', async () => {
    expect(usageOf(await openai(F.UO3_CUMULATIVE))).toEqual({ inputTokens: 900, outputTokens: 7 });
  });
  it('UO4 没有任何 usage：不发 usage 事件（不是 0/0）', async () => {
    const events = await openai(F.UO4_NO_USAGE);
    expect(usagesOf(events)).toEqual([]);
    expect(events.at(-1)).toEqual({ kind: 'done', stopReason: 'endTurn' });
  });
  it('UO5 只有 total_tokens：不伪造拆分，不发 usage 事件', async () => {
    expect(usagesOf(await openai(F.UO5_TOTAL_ONLY))).toEqual([]);
  });
  it('UO6 推理另算的端点把推理并进输出；推理大于输出的越界值丢掉', async () => {
    expect(usageOf(await openai(F.UO6_REASONING_APART))).toEqual({ inputTokens: 100, outputTokens: 80, reasoningTokens: 30 });
    expect(usageOf(await openai(F.UO6_REASONING_OVER))).toEqual({ inputTokens: 100, outputTokens: 50 });
  });
  it('UO7 缓存读取大于输入：丢掉这个子维度', async () => {
    expect(usageOf(await openai(F.UO7_CACHE_OVER))).toEqual({ inputTokens: 1000, outputTokens: 10 });
  });
  it('UO8 有效的 usage 之后又来了空对象或只有 total_tokens 的 usage：不覆盖已有的有效报告', async () => {
    expect(usageOf(await openai(F.UO8_VALID_THEN_EMPTY))).toEqual({ inputTokens: 900, outputTokens: 7 });
    expect(usageOf(await openai(F.UO8_VALID_THEN_TOTAL_ONLY))).toEqual({ inputTokens: 900, outputTokens: 7 });
  });
  it('UO9 缓存读取与写入之和大于输入：两个子维度不可能同时成立，丢掉写入、保留读取', async () => {
    expect(usageOf(await openai(F.UO9_CACHE_SUM_OVER))).toEqual({ inputTokens: 1000, outputTokens: 10, cacheReadTokens: 800 });
  });
});

describe('Gemini usage 归一化', () => {
  it('UG1 逐帧增长、thoughts 不在 candidates 里：输出 = candidates + thoughts，缓存不加进输入', async () => {
    expect(usageOf(await gemini(F.UG1_THOUGHTS_APART))).toEqual({ inputTokens: 500, cacheReadTokens: 400, outputTokens: 260, reasoningTokens: 200 });
  });
  it('UG2 thoughts 已在 candidates 里（total = prompt + candidates）：不再相加', async () => {
    expect(usageOf(await gemini(F.UG2_THOUGHTS_INSIDE))).toEqual({ inputTokens: 500, outputTokens: 260, reasoningTokens: 200 });
  });
  it('UG3 没有 totalTokenCount：按 candidates + thoughts', async () => {
    expect(usageOf(await gemini(F.UG3_NO_TOTAL))).toEqual({ inputTokens: 500, outputTokens: 260, reasoningTokens: 200 });
  });
  it('UG4 后面的帧不带 promptTokenCount：逐字段覆盖，输入不丢', async () => {
    expect(usageOf(await gemini(F.UG4_FIELDWISE))).toEqual({ inputTokens: 500, outputTokens: 60 });
  });
  it('UG5 有 finishReason 而没有 usageMetadata：不发 usage 事件；两者都没有仍按断流抛 retryable', async () => {
    const events = await gemini(F.UG5_NO_USAGE);
    expect(usagesOf(events)).toEqual([]);
    expect(events.at(-1)).toEqual({ kind: 'done', stopReason: 'endTurn' });
    await expect(gemini(F.UG5_TRUNCATED)).rejects.toMatchObject({ retryable: true, message: 'SSE 流提前结束' });
  });
  it('UG6 promptFeedback 拦截、只报了输入：输出标为未报告，done 为 refusal', async () => {
    const events = await gemini(F.UG6_BLOCKED);
    expect(usageOf(events)).toEqual({ inputTokens: 77, outputTokens: 0, unreported: ['output'] });
    expect(events.at(-1)).toEqual({ kind: 'done', stopReason: 'refusal' });
  });
  it('UG7 最后一帧发两遍：不翻倍', async () => {
    expect(usageOf(await gemini(F.UG7_DUP_LAST))).toEqual({ inputTokens: 500, cacheReadTokens: 400, outputTokens: 260, reasoningTokens: 200 });
  });
  it('UG8 toolUsePromptTokenCount 计入输入；判断 thoughts 在不在 candidates 里时 total 要把它算上', async () => {
    expect(usageOf(await gemini(F.UG8_TOOL_USE_APART))).toEqual({ inputTokens: 540, outputTokens: 260, reasoningTokens: 200 });
    expect(usageOf(await gemini(F.UG8_TOOL_USE_INSIDE))).toEqual({ inputTokens: 540, outputTokens: 260, reasoningTokens: 200 });
  });
});
