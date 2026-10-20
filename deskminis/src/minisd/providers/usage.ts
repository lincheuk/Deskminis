/**
 * F02 usage 归一化：把三家服务商各自的用量字段归一到 shared/usage.ts 的 TokenUsage。
 *
 * 共同规则：
 *  1. 每个原始字段只保留一个值，从不相加——重复事件与累计更新因此是幂等的。OpenAI 与 Gemini 取最后一次有效报告，
 *     Anthropic 取已见值里最大的（理由见 AnthropicUsageAcc）；
 *  2. 字段不是有限非负数就当没出现；
 *  3. 两个总数都没出现时 result() 返回 undefined，adapter 不发 usage 事件（不拿 0/0 冒充用量）。
 *     只缺一个时该字段写 0 并列进 unreported；
 *  4. 子维度只在原始字段出现时才带键，值为 0 也带（服务商报了 0）。子维度大于所属总数时丢掉这个子维度；
 *  5. 归一化后的 inputTokens 已含缓存读写、outputTokens 已含推理：子维度是「其中」项，任何地方都不再往总数上加。
 *
 * 官方定义的出处（2026-10-03 读取；没有 API Key，没有真实调用验证）：
 *  - Anthropic：platform.claude.com 的 prompt-caching（总输入 = cache_read + cache_creation + input_tokens；cache_creation 对象是
 *    cache_creation_input_tokens 的拆分）、streaming（message_delta.usage 是累计值）、thinking-steering-and-cost
 *    （usage.output_tokens_details.thinking_tokens 是 output_tokens 的子集，流式只在最后一个 message_delta）；
 *  - OpenAI：openai-node 的 CompletionUsage（prompt_tokens 含缓存；prompt_tokens_details.cached_tokens / cache_write_tokens；
 *    completion_tokens_details.reasoning_tokens；total_tokens = prompt + completion）；DeepSeek 接口文档（prompt_cache_hit_tokens）；
 *  - Gemini：googleapis generative_service.proto 的 UsageMetadata（promptTokenCount 含缓存内容）与 js-genai 参考页
 *    （totalTokenCount 是 prompt、candidates、tool_use_prompt、thoughts 之和）。
 */
import type { TokenUsage, UsageDim } from '../../shared/usage';

/** 有限非负数才算出现。 */
const num = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
const obj = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;

interface Totals { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; reasoning?: number }

/** 归一化的最后一步（三家共用）：两个总数都没有 → undefined；缺一个写 0 并标未报告；子维度越界则丢。 */
function assemble(t: Totals): TokenUsage | undefined {
  if (t.input === undefined && t.output === undefined) return undefined;
  const inputTokens = t.input ?? 0; const outputTokens = t.output ?? 0;
  const unreported: UsageDim[] = [...(t.input === undefined ? ['input' as const] : []), ...(t.output === undefined ? ['output' as const] : [])];
  // 所属总数没报时子维度没有可归属的总数，一并不带；大于所属总数的是越界值，丢掉
  const within = (v: number | undefined, total: number | undefined): number | undefined =>
    total !== undefined && v !== undefined && v <= total ? v : undefined;
  const cacheRead = within(t.cacheRead, t.input);
  let cacheWrite = within(t.cacheWrite, t.input);
  // 读写之和大于输入：两个子维度不可能同时成立，丢掉写入
  if (cacheWrite !== undefined && (cacheRead ?? 0) + cacheWrite > inputTokens) cacheWrite = undefined;
  const reasoning = within(t.reasoning, t.output);
  return {
    inputTokens, outputTokens,
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
    ...(unreported.length > 0 ? { unreported } : {}),
  };
}

/**
 * Anthropic：message_start.message.usage 与每个 message_delta.usage 都 observe，五个原始计数各自取已见值的最大值。
 * 官方定义里 message_delta.usage 是累计值、单调不减，取最大与取最后一次等价。差别只在不守这条的中转：
 * F02 之前输入只从 message_start 取，如果中转在 message_delta 里把 input_tokens 补成 0，取最后一次会用 0 盖掉真实输入；
 * 取最大则起始补 0 与末尾补 0 都不丢数。有没有中转这样做没有查到出处，这是按字段形状做的防御。
 * cache_creation 对象是 cache_creation_input_tokens 的拆分，不读——读了就是双计。
 */
export class AnthropicUsageAcc {
  private input?: number; private cacheWrite?: number; private cacheRead?: number; private output?: number; private thinking?: number;

  observe(usage: unknown): void {
    const u = obj(usage);
    if (!u) return;
    const max = (cur: number | undefined, v: unknown): number | undefined => {
      const n = num(v);
      return n === undefined ? cur : cur === undefined ? n : Math.max(cur, n);
    };
    this.input = max(this.input, u.input_tokens);
    this.cacheWrite = max(this.cacheWrite, u.cache_creation_input_tokens);
    this.cacheRead = max(this.cacheRead, u.cache_read_input_tokens);
    this.output = max(this.output, u.output_tokens);
    this.thinking = max(this.thinking, obj(u.output_tokens_details)?.thinking_tokens);
  }

  result(): TokenUsage | undefined {
    // input_tokens 只是未缓存的那部分：总输入要把缓存读取与写入加回来。input_tokens 没出现时总输入算不出来，缓存两项也不带
    const input = this.input === undefined ? undefined : this.input + (this.cacheWrite ?? 0) + (this.cacheRead ?? 0);
    return assemble({ input, output: this.output, cacheRead: this.cacheRead, cacheWrite: this.cacheWrite, reasoning: this.thinking });
  }
}

/**
 * OpenAI 兼容：usage 是对象且带有限的 prompt_tokens 或 completion_tokens 时，整体替换为最新一份；null、空对象、
 * 只有 total_tokens 的都不动。官方的末尾空 choices 块、每块都带累计 usage 的中转，都归到「最后一次有效覆盖」。
 */
export class OpenAIUsageAcc {
  private last?: Record<string, unknown>;

  observe(usage: unknown): void {
    const u = obj(usage);
    if (!u) return;
    if (num(u.prompt_tokens) === undefined && num(u.completion_tokens) === undefined) return;
    this.last = u;
  }

  result(): TokenUsage | undefined {
    const u = this.last;
    if (!u) return undefined;
    const prompt = num(u.prompt_tokens); const completion = num(u.completion_tokens); const total = num(u.total_tokens);
    const promptDetails = obj(u.prompt_tokens_details);
    const reasoning = num(obj(u.completion_tokens_details)?.reasoning_tokens);
    // 防御性规则：官方定义里推理含在 completion_tokens 里。total 恰好等于三项之和时，这个端点把推理另算，输出要把它加回来
    const apart = prompt !== undefined && completion !== undefined && total !== undefined && reasoning !== undefined && reasoning > 0
      && total === prompt + completion + reasoning;
    return assemble({
      input: prompt,   // 已含缓存，不再加
      output: completion === undefined ? undefined : apart ? completion + reasoning! : completion,
      // DeepSeek 用 prompt_cache_hit_tokens 报缓存命中（prompt_tokens = hit + miss）
      cacheRead: num(promptDetails?.cached_tokens) ?? num(u.prompt_cache_hit_tokens),
      cacheWrite: num(promptDetails?.cache_write_tokens),
      reasoning,
    });
  }
}

/**
 * Gemini：每块的 usageMetadata 逐字段覆盖（后面的块不带某个字段时保留先前的值）。
 * 输出要不要加 thoughts：proto 写 candidatesTokenCount 是「response candidates」，js-genai 写 totalTokenCount 是四项之和，
 * 两处说法不一致，所以用 totalTokenCount 判定——total 恰好等于 prompt + toolUsePrompt + candidates 时 thoughts 已在 candidates 里；
 * 其余（含没有 total）按 candidates + thoughts。
 */
export class GeminiUsageAcc {
  private prompt?: number; private toolUse?: number; private candidates?: number; private thoughts?: number; private total?: number; private cached?: number;

  observe(usageMetadata: unknown): void {
    const u = obj(usageMetadata);
    if (!u) return;
    this.prompt = num(u.promptTokenCount) ?? this.prompt;
    this.toolUse = num(u.toolUsePromptTokenCount) ?? this.toolUse;
    this.candidates = num(u.candidatesTokenCount) ?? this.candidates;
    this.thoughts = num(u.thoughtsTokenCount) ?? this.thoughts;
    this.total = num(u.totalTokenCount) ?? this.total;
    this.cached = num(u.cachedContentTokenCount) ?? this.cached;
  }

  result(): TokenUsage | undefined {
    const p = this.prompt; const tu = this.toolUse ?? 0; const c = this.candidates; const t = this.thoughts;
    const input = p === undefined ? undefined : p + tu;
    let output: number | undefined;
    if (c === undefined && t === undefined) output = undefined;
    else if (t === undefined || t === 0) output = c ?? 0;
    else if (this.total !== undefined && p !== undefined && c !== undefined && this.total === p + tu + c) output = c;
    else output = (c ?? 0) + t;
    return assemble({ input, output, cacheRead: this.cached, reasoning: t });
  }
}
