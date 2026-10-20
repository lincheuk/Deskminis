/**
 * F02 三家 adapter 的 usage 报文夹具（验收 2）。
 *
 * 形状取自官方文档，没有真实调用（本机没有 API Key）。读取日期一律 2026-10-03。每个夹具上方写出处；
 * 文档没有逐字示例的（OpenAI 的末帧、Gemini 的 REST 流、各种缺字段与重复形态）按字段定义拼出，注明「按字段定义拼出，非文档原样」。
 * 数字照抄文档示例的地方注明「数字取自文档」。
 */
export type Frame = Record<string, unknown>;

/** Anthropic：event 行 + data 行。 */
export const anthropicSse = (frames: Frame[]): string =>
  frames.map(f => `event: ${String(f.type)}\ndata: ${JSON.stringify(f)}\n\n`).join('');
/** OpenAI 兼容：data 行，末尾 [DONE]（done=false 用来造断流）。 */
export const openaiSse = (frames: Frame[], done = true): string =>
  frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : '');
/** Gemini（streamGenerateContent?alt=sse）：只有 data 行。 */
export const geminiSse = (frames: Frame[]): string => frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join('');

// ───────────────────────── Anthropic ─────────────────────────
// 帧序列的骨架取自 https://platform.claude.com/docs/en/build-with-claude/streaming 的「Basic streaming request」示例：
// message_start → content_block_start → ping → content_block_delta × n → content_block_stop → message_delta → message_stop。

const aStart = (usage?: Frame): Frame => ({
  type: 'message_start',
  message: {
    id: 'msg_fixture', type: 'message', role: 'assistant', content: [], model: 'claude-fixture',
    stop_reason: null, stop_sequence: null, ...(usage ? { usage } : {}),
  },
});
const aText = (text: string): Frame[] => [
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'ping' },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  { type: 'content_block_stop', index: 0 },
];
const aDelta = (usage?: Frame, stop = 'end_turn'): Frame => ({
  type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, ...(usage ? { usage } : {}),
});
const A_STOP: Frame = { type: 'message_stop' };

/** UA1 streaming 文档基本示例（数字取自文档）：message_start 的 usage {input_tokens:25, output_tokens:1}，message_delta 的 usage {output_tokens:15}。 */
export const UA1_BASIC: Frame[] = [aStart({ input_tokens: 25, output_tokens: 1 }), ...aText('Hello!'), aDelta({ output_tokens: 15 }), A_STOP];

/** UA2 https://platform.claude.com/docs/en/build-with-claude/prompt-caching 的用量示例（数字取自文档）：
 *  total input = cache_read + cache_creation + input_tokens；cache_creation 对象是 cache_creation_input_tokens 的拆分。
 *  文档给的是响应体的 usage 对象；流式时它出现在 message_start（按字段定义拼出，非文档原样）。 */
export const UA2_CACHE: Frame[] = [
  aStart({
    input_tokens: 2048, cache_read_input_tokens: 1800, cache_creation_input_tokens: 248, output_tokens: 1,
    cache_creation: { ephemeral_5m_input_tokens: 148, ephemeral_1h_input_tokens: 100 },
  }),
  ...aText('ok'), aDelta({ output_tokens: 503 }), A_STOP,
];

/** UA3 streaming 文档「Streaming request with web search tool use」示例（数字取自文档）：
 *  message_start 报 input_tokens 2679，末尾 message_delta 重报更大的累计值 10682。 */
export const UA3_CUMULATIVE: Frame[] = [
  aStart({ input_tokens: 2679, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 3 }),
  ...aText('searching'),
  aDelta({ input_tokens: 10682, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 510, server_tool_use: { web_search_requests: 1 } }),
  A_STOP,
];

/** UA4 重复事件（按字段定义拼出，非文档原样）：同一个 delta 发两遍；start 发两遍；两次 delta 8 → 15（累计值）。 */
export const UA4_DUP_DELTA: Frame[] = [aStart({ input_tokens: 25, output_tokens: 1 }), ...aText('Hello!'), aDelta({ output_tokens: 15 }), aDelta({ output_tokens: 15 }), A_STOP];
export const UA4_DUP_START: Frame[] = [aStart({ input_tokens: 25, output_tokens: 1 }), aStart({ input_tokens: 25, output_tokens: 1 }), ...aText('Hello!'), aDelta({ output_tokens: 15 }), A_STOP];
export const UA4_TWO_DELTAS: Frame[] = [aStart({ input_tokens: 25, output_tokens: 1 }), ...aText('Hello!'), aDelta({ output_tokens: 8 }), aDelta({ output_tokens: 15 }), A_STOP];

/** UA5 streaming 文档「Streaming request with extended thinking」示例的形状：message_start 与 message_delta 都不带 usage。 */
export const UA5_NO_USAGE: Frame[] = [aStart(), ...aText('27 * 453 = 12,231'), aDelta(), A_STOP];

/** UA6 缺字段（按字段定义拼出，非文档原样）：start 只有 input_tokens，delta 没有 usage。 */
export const UA6_NO_OUTPUT: Frame[] = [aStart({ input_tokens: 5 }), ...aText('hi'), aDelta(), A_STOP];

/** UA7 https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost（数字取自文档）：
 *  usage.output_tokens_details.thinking_tokens 是 output_tokens 的子集，流式只出现在最后一个 message_delta。 */
export const UA7_THINKING: Frame[] = [
  aStart({ input_tokens: 40, output_tokens: 1 }), ...aText('answer'),
  aDelta({ output_tokens: 348, output_tokens_details: { thinking_tokens: 312 } }), A_STOP,
];

/** UA8 越界与非法值（按字段定义拼出，非文档原样）。 */
export const UA8_THINKING_OVER: Frame[] = [
  aStart({ input_tokens: 40, output_tokens: 1 }), ...aText('answer'),
  aDelta({ output_tokens: 100, output_tokens_details: { thinking_tokens: 500 } }), A_STOP,
];
export const UA8_INVALID: Frame[] = [
  aStart({ input_tokens: 40, output_tokens: 1, cache_read_input_tokens: -3, cache_creation_input_tokens: '12' }), ...aText('answer'),
  aDelta({ output_tokens: 100, output_tokens_details: { thinking_tokens: 'many' } }), A_STOP,
];

/** UA9 中转形态（按字段形状拼出，非文档原样，没有查到出处）：message_delta 里把 input_tokens 补成 0；以及反过来的一份。 */
export const UA9_DELTA_ZERO: Frame[] = [aStart({ input_tokens: 1200, output_tokens: 1 }), ...aText('ok'), aDelta({ input_tokens: 0, output_tokens: 40 }), A_STOP];
export const UA9_START_ZERO: Frame[] = [aStart({ input_tokens: 0, output_tokens: 1 }), ...aText('ok'), aDelta({ input_tokens: 1200, output_tokens: 40 }), A_STOP];

// ───────────────────────── OpenAI 兼容 ─────────────────────────
// 字段定义取自 openai-node src/resources/completions.ts（CompletionUsage：prompt_tokens、completion_tokens、total_tokens、
// prompt_tokens_details.cached_tokens / cache_write_tokens、completion_tokens_details.reasoning_tokens）与
// src/resources/chat/completions/completions.ts（stream_options.include_usage：除最后一块外 usage 为 null，最后一块 choices 为空数组）。
// 下面的帧都是按字段定义拼出，非文档原样。

const oText = (content: string, usage?: unknown): Frame => ({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content } }], ...(usage !== undefined ? { usage } : {}) });
const oFinish = (usage?: unknown, reason = 'stop'): Frame => ({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: reason }], ...(usage !== undefined ? { usage } : {}) });
const oUsage = (usage: unknown): Frame => ({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', choices: [], usage });

/** UO1 官方形态：各帧 usage:null，末帧 choices:[] 带完整明细。 */
export const UO1_FINAL_CHUNK: Frame[] = [
  oText('he', null), oText('llo', null), oFinish(null),
  oUsage({
    prompt_tokens: 1000, completion_tokens: 300, total_tokens: 1300,
    prompt_tokens_details: { cached_tokens: 800, cache_write_tokens: 100 },
    completion_tokens_details: { reasoning_tokens: 120 },
  }),
];

/** UO2 DeepSeek 形状（https://api-docs.deepseek.com/api/create-chat-completion：prompt_tokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens）。 */
export const UO2_DEEPSEEK: Frame[] = [
  oText('ok'), oFinish(),
  oUsage({ prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050, prompt_cache_hit_tokens: 700, prompt_cache_miss_tokens: 300 }),
];

/** UO3 每帧都带累计 usage 的中转，末帧重复一次。 */
export const UO3_CUMULATIVE: Frame[] = [
  oText('a', { prompt_tokens: 900, completion_tokens: 1, total_tokens: 901 }),
  oText('b', { prompt_tokens: 900, completion_tokens: 2, total_tokens: 902 }),
  oFinish({ prompt_tokens: 900, completion_tokens: 7, total_tokens: 907 }),
  oUsage({ prompt_tokens: 900, completion_tokens: 7, total_tokens: 907 }),
];

/** UO4 没有任何 usage（不认 stream_options 的兼容端点）。 */
export const UO4_NO_USAGE: Frame[] = [oText('ok'), oFinish()];

/** UO5 只有 total_tokens。 */
export const UO5_TOTAL_ONLY: Frame[] = [oText('ok'), oFinish(), oUsage({ total_tokens: 1300 })];

/** UO6 推理另算的端点（total = prompt + completion + reasoning）与官方形态（推理含在 completion 里）的对照。
 *  后一份的 reasoning_tokens 大于 completion_tokens，是越界值。 */
export const UO6_REASONING_APART: Frame[] = [oText('ok'), oFinish(), oUsage({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 180, completion_tokens_details: { reasoning_tokens: 30 } })];
export const UO6_REASONING_OVER: Frame[] = [oText('ok'), oFinish(), oUsage({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, completion_tokens_details: { reasoning_tokens: 80 } })];

/** UO7 越界的缓存明细。 */
export const UO7_CACHE_OVER: Frame[] = [oText('ok'), oFinish(), oUsage({ prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010, prompt_tokens_details: { cached_tokens: 5000 } })];

/** UO8 有效的 usage 之后又来了不带 prompt_tokens / completion_tokens 的 usage 对象（空对象、只有 total_tokens）。
 *  按字段形状拼出的中转形态，非文档原样，没有查到出处。 */
export const UO8_VALID_THEN_EMPTY: Frame[] = [oText('ok'), oFinish({ prompt_tokens: 900, completion_tokens: 7, total_tokens: 907 }), oUsage({})];
export const UO8_VALID_THEN_TOTAL_ONLY: Frame[] = [oText('ok'), oFinish({ prompt_tokens: 900, completion_tokens: 7, total_tokens: 907 }), oUsage({ total_tokens: 907 })];

/** UO9 缓存读取与写入各自都不大于输入、加起来却超过输入（800 + 300 > 1000）。按字段定义拼出，非文档原样。 */
export const UO9_CACHE_SUM_OVER: Frame[] = [oText('ok'), oFinish(), oUsage({ prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010, prompt_tokens_details: { cached_tokens: 800, cache_write_tokens: 300 } })];

// ───────────────────────── Gemini ─────────────────────────
// 字段定义取自 googleapis generative_service.proto（v1beta）的 UsageMetadata：promptTokenCount（含缓存内容）、
// cachedContentTokenCount、candidatesTokenCount、toolUsePromptTokenCount、thoughtsTokenCount、totalTokenCount；
// js-genai 的 GenerateContentResponseUsageMetadata 参考页写 totalTokenCount 是 prompt、candidates、tool_use_prompt、thoughts 之和。
// REST 流没有逐字示例，下面的帧都是按字段定义拼出，非文档原样。

const gText = (text: string, usageMetadata?: Frame, finishReason?: string): Frame => ({
  candidates: [{ content: { role: 'model', parts: [{ text }] }, ...(finishReason ? { finishReason } : {}) }],
  ...(usageMetadata ? { usageMetadata } : {}),
});

/** UG1 每帧带 usageMetadata 逐帧增长；末帧 thoughts 不在 candidates 里（total = prompt + candidates + thoughts）。 */
export const UG1_THOUGHTS_APART: Frame[] = [
  gText('a', { promptTokenCount: 500, cachedContentTokenCount: 400, candidatesTokenCount: 10, totalTokenCount: 510 }),
  gText('b', { promptTokenCount: 500, cachedContentTokenCount: 400, candidatesTokenCount: 40, thoughtsTokenCount: 200, totalTokenCount: 740 }),
  gText('c', { promptTokenCount: 500, cachedContentTokenCount: 400, candidatesTokenCount: 60, thoughtsTokenCount: 200, totalTokenCount: 760 }, 'STOP'),
];
const UG1_LAST = UG1_THOUGHTS_APART[2];

/** UG2 thoughts 已在 candidates 里（total = prompt + candidates）。 */
export const UG2_THOUGHTS_INSIDE: Frame[] = [gText('c', { promptTokenCount: 500, candidatesTokenCount: 260, thoughtsTokenCount: 200, totalTokenCount: 760 }, 'STOP')];

/** UG3 没有 totalTokenCount。 */
export const UG3_NO_TOTAL: Frame[] = [gText('c', { promptTokenCount: 500, candidatesTokenCount: 60, thoughtsTokenCount: 200 }, 'STOP')];

/** UG4 前面的帧只有 promptTokenCount，后面的帧不带它。 */
export const UG4_FIELDWISE: Frame[] = [
  gText('a', { promptTokenCount: 500 }),
  gText('b', { candidatesTokenCount: 60, totalTokenCount: 560 }, 'STOP'),
];

/** UG5 有 finishReason、没有任何 usageMetadata；以及两者都没有的断流。 */
export const UG5_NO_USAGE: Frame[] = [gText('a'), gText('b', undefined, 'STOP')];
export const UG5_TRUNCATED: Frame[] = [gText('a')];

/** UG6 promptFeedback 拦截，只带 promptTokenCount。 */
export const UG6_BLOCKED: Frame[] = [{ promptFeedback: { blockReason: 'SAFETY' }, usageMetadata: { promptTokenCount: 77 } }];

/** UG7 最后一帧发两遍。 */
export const UG7_DUP_LAST: Frame[] = [...UG1_THOUGHTS_APART, UG1_LAST];

/** UG8 带 toolUsePromptTokenCount（proto 把它与 promptTokenCount 分开给；js-genai 写 totalTokenCount 是四项之和）。
 *  前一份 thoughts 不在 candidates 里（total = 500 + 40 + 60 + 200），后一份已在 candidates 里（total = 500 + 40 + 260）。
 *  按字段定义拼出，非文档原样。 */
export const UG8_TOOL_USE_APART: Frame[] = [gText('c', { promptTokenCount: 500, toolUsePromptTokenCount: 40, candidatesTokenCount: 60, thoughtsTokenCount: 200, totalTokenCount: 800 }, 'STOP')];
export const UG8_TOOL_USE_INSIDE: Frame[] = [gText('c', { promptTokenCount: 500, toolUsePromptTokenCount: 40, candidatesTokenCount: 260, thoughtsTokenCount: 200, totalTokenCount: 800 }, 'STOP')];
