/* 部分改编自 pi-mono（https://github.com/badlogic/pi-mono）
 *   上游：packages/ai/src/utils/overflow.ts @ 8676a0d（v0.87.1；该文件最后一次改动在 0e28320）
 *   许可：MIT，Copyright (c) 2025 Mario Zechner（全文见仓库根 THIRD-PARTY-NOTICES.md）
 *   本文件已修改：OVERFLOW_PATTERNS / NON_OVERFLOW_PATTERNS 两张正则表原样移植；判定函数按 DeskMinis 的
 *   ProviderError 改写（按报错文本加 HTTP 状态判定，加 429/5xx 状态闸），不含 Cerebras 无 body 专条与按 usage 判定的静默溢出 */

/**
 * 上下文超窗（溢出）的识别（W2a-2 · 止血波设计稿 §3 第 1 条）。
 *
 * 为什么要单独认出来：超窗的 400 在旧分类里与限流、无效 key 一样是「可降级」，loop 立刻换组里下一个成员——
 * 下一个成员窗口往往一样大甚至更小，于是整条链挨个白打一遍 400，最后报「所有模型均不可用」，用户完全不知道
 * 真正的原因是对话太长。认出来之后 ProviderError 带 code='contextOverflow'，loop 只降级到窗口更大的槽位，
 * 找不到就报「上下文已满」并给出接力草稿。
 *
 * 为什么直接搬 pi 的表：这是各家真实报文逐条攒出来的（每条后面注明了厂商），自己重写只会漏；
 * 正则一字不改，将来上游补新厂商时可以逐行对照同步。
 *
 * 没搬的两条及原因：
 *  - Cerebras「400/413 status code (no body)」：只对 Cerebras 成立，要按 provider 名判断，
 *    而本仓的 OpenAI 兼容 provider 不知道对端是谁；普通 400 空 body 若被当成超窗，反而把真正的请求错误藏起来。
 *  - 按 usage 判的静默溢出（z.ai 超窗仍回 200、小米 MiMo 以 length 收尾且输出为 0）：那是「成功返回之后」的判断，
 *    不是报错分类；要以真实 usage 定水位，归 W5 的上下文管线。
 */

/**
 * 各家超窗报错的文本特征（原样移植）。报文样例：
 *
 * - Anthropic: "prompt is too long: 213462 tokens > 200000 maximum"
 * - Anthropic: "413 {\"error\":{\"type\":\"request_too_large\",\"message\":\"Request exceeds the maximum size\"}}"
 * - OpenAI: "Your input exceeds the context window of this model"
 * - OpenAI/LiteLLM: "Requested token count exceeds the model's maximum context length of 131072 tokens"
 * - OpenAI-compatible: "Input length (265330) exceeds model's maximum context length (262144)."
 * - Google: "The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)"
 * - xAI: "This model's maximum prompt length is 131072 but the request contains 537812 tokens"
 * - Groq: "Please reduce the length of the messages or completion"
 * - OpenRouter: "This endpoint's maximum context length is X tokens. However, you requested about Y tokens"
 * - OpenRouter/Poolside: "Input length X exceeds the maximum allowed input length of Y tokens."
 * - Together AI: "The input (X tokens) is longer than the model's context length (Y tokens)."
 * - llama.cpp: "the request exceeds the available context size, try increasing it"
 * - LM Studio: "tokens to keep from the initial prompt is greater than the context length"
 * - GitHub Copilot: "prompt token count of X exceeds the limit of Y"
 * - MiniMax: "invalid params, context window exceeds limit"
 * - Kimi For Coding: "Your request exceeded model token limit: X (requested: Y)"
 * - DS4: "Prompt has X tokens, but the configured context size is Y tokens"
 * - Mistral: "Prompt contains X tokens ... too large for model with Y maximum context length"
 * - z.ai: `{"code":"1261","message":"Prompt too long"}`
 * - DashScope/Qwen: "Range of input length should be [1, X]" (HTTP 400 invalid_parameter_error)
 * - Ollama: "prompt too long; exceeded max context length by X tokens"
 * - DeepSeek（本仓补注，命中 OpenRouter 那条）: "This model's maximum context length is 131072 tokens"
 */
export const OVERFLOW_PATTERNS: readonly RegExp[] = [
  /prompt (?:is )?too long/i, // Anthropic and z.ai token overflow
  /request_too_large/i, // Anthropic request byte-size overflow (HTTP 413)
  /input is too long for requested model/i, // Amazon Bedrock
  /exceeds the context window/i, // OpenAI (Completions & Responses API)
  /exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i, // OpenAI-compatible proxies (LiteLLM)
  /input token count.*exceeds the maximum/i, // Google (Gemini)
  /maximum prompt length is \d+/i, // xAI (Grok)
  /reduce the length of the messages/i, // Groq
  /maximum context length is \d+ tokens/i, // OpenRouter (most backends)
  /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i, // OpenRouter/Poolside
  /input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i, // Together AI
  /exceeds the limit of \d+/i, // GitHub Copilot
  /exceeds the available context size/i, // llama.cpp server
  /greater than the context length/i, // LM Studio
  /context window exceeds limit/i, // MiniMax
  /exceeded model token limit/i, // Kimi For Coding
  /too large for model with \d+ maximum context length/i, // Mistral
  /prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i, // DS4 server
  /model_context_window_exceeded/i, // z.ai non-standard finish_reason surfaced as error text
  /prompt too long; exceeded (?:max )?context length/i, // Ollama explicit overflow error
  /range of input length should be/i, // DashScope / Qwen Token Plan
  /context[_ ]length[_ ]exceeded/i, // Generic fallback
  /too many tokens/i, // Generic fallback
  /token limit exceeded/i, // Generic fallback
];

/**
 * 命中这些的一律不算超窗，即使同时命中上面的表（原样移植）。
 * 例：Bedrock 的限流报文「ThrottlingException: Too many tokens, please wait before trying again.」
 * 会被 /too many tokens/ 误认成超窗。
 */
export const NON_OVERFLOW_PATTERNS: readonly RegExp[] = [
  /^(Throttling error|Service unavailable):/i, // AWS Bedrock non-overflow errors (human-readable prefixes from formatBedrockError)
  /rate limit/i, // Generic rate limiting
  /too many requests/i, // Generic HTTP 429 style
];

/**
 * 这条报错是不是上下文超窗。
 * 状态闸在最前：429 是限流、5xx 是服务端故障，换一个窗口更大的模型解决不了，必须留给原来的
 * 限流降级与重试梯——pi 的判定不看状态码（它拿的是已经分好类的错误文本），本仓的 ProviderError
 * 会把整个响应体拼进 message，429 的响应体里出现 "too many tokens" 这类字样并不罕见。
 * 之后先排除、再匹配，顺序与上游一致。没有状态码（流中途的错误文本、包装过的异常）只按文本判。
 */
export function isContextOverflowMessage(message: string, status?: number): boolean {
  if (status !== undefined && (status === 429 || status >= 500)) return false;
  if (NON_OVERFLOW_PATTERNS.some(p => p.test(message))) return false;
  return OVERFLOW_PATTERNS.some(p => p.test(message));
}
