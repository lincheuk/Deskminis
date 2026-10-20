/** F01R：从 models.dev 公开快照（2026-10-02，research\models-dev-api-2026-10-02.json）原样摘出的记录，只保留解析器读的字段
 *  （api、name、limit、modalities、tool_call、reasoning、reasoning_options）。不联网、数值没有改动。
 *  由 work\verify\F01R\extract-snapshot-fixture.mjs 生成，不要手改：脚本对下面点名的每个型号自检——摘录后重算的
 *  佐证最小值（窗口、输出）、工具 / 推理的表态家数（3 家封顶）、模态逐项资料都与全量快照相同，不一致就不写文件。
 *  只有点名的型号保证汇总结果与全量快照一致；deepseek、volcengine 另带自己的记录，只为让端点被认出来。
 *  点名型号（服务商记录数：全量 → 摘录）：
 *   - kimi-k3（29 → 6）：A1 output == context, corroborated 65536
 *   - kimi-k2.6（23 → 6）：A1 output == context; C2 loopback api
 *   - deepseek-ai/DeepSeek-V3（6 → 3）：A1 corroborated 8192
 *   - Qwen/Qwen3-32B（6 → 4）：A1 corroborated 8192
 *   - gemini-3-pro-image-preview（4 → 3）：A1 output > context
 *   - moonshotai/kimi-k2.6（13 → 5）：A1 placeholder 0.9; D4 empty reasoning_options outside Google
 *   - mistralai/mistral-large-2512（3 → 3）：A1 placeholder 0.8
 *   - z-ai/GLM-4.5-Air（1 → 1）：A1 boundary 0.768
 *   - glm-4.5（5 → 3）：A1 boundary exactly 0.75
 *   - glm-4.6（8 → 3）：A1 0.64 kept; C1 image negative with >= 3 providers
 *   - z-ai/glm-5.2（11 → 3）：A1 placeholder 0.9 with corroborated 128000
 *   - deepseek-v4-pro（29 → 5）：A1 trusted endpoint value kept
 *   - claude-sonnet-4-6（22 → 4）：A1 unchanged
 *   - claude-opus-4-8（22 → 4）：A1 unchanged; D4 official Anthropic not restored
 *   - claude-haiku-4-5（15 → 3）：A1 unchanged
 *   - claude-opus-5-5（10 → 3）：A3 binding model
 *   - gpt-5-pro（7 → 4）：A1 unchanged
 *   - gpt-3.5-turbo（2 → 2）：C1 endpoint negative stays confirmed
 *   - openai/gpt-5.4（17 → 3）：A2 endpoint record without text, others list text
 *   - deepseek-reasoner（2 → 2）：C1 two-provider negative
 *   - doubao-seed-1-6-250615（1 → 1）：C1 single-provider negative
 *   - sonar（5 → 3）：C1 negative with >= 3 providers
 *   - grok-3（1 → 1）：C1 single-provider image negative
 *   - qwen/qwen3-coder-30b（1 → 1）：C2 loopback api
 *   - gemini-flash-latest（2 → 2）：D4 efforts only
 *   - gemma-4-31b-it（7 → 3）：D4 toggle only
 *   - gemini-2.5-pro（15 → 4）：D4 budget range
 *   - gemini-2.5-flash-image（6 → 4）：D4 empty reasoning_options
 */
const EXCERPT: Record<string, { api?: string; models: Record<string, unknown> }> = {
  "302ai": { api: "https://api.302.ai/v1", models: {
    "gemini-2.5-flash-image": {"name":"gemini-2.5-flash-image","limit":{"context":32768,"output":32768},"modalities":{"input":["text","image"],"output":["text"]},"tool_call":false,"reasoning":false},
    "gemini-2.5-pro": {"name":"gemini-2.5-pro","limit":{"context":1000000,"output":65536},"modalities":{"input":["text","image"],"output":["text"]},"tool_call":true,"reasoning":false},
    "gemini-3-pro-image-preview": {"name":"gemini-3-pro-image-preview","limit":{"context":32768,"output":64000},"modalities":{"input":["text","image"],"output":["text"]},"tool_call":false,"reasoning":false},
  } },
  "abacus": { api: "https://routellm.abacus.ai/v1", models: {
    "Qwen/Qwen3-32B": {"name":"Qwen3 32B","limit":{"context":131072,"output":8192},"modalities":{"input":["text"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[]},
    "gemini-3-pro-image-preview": {"name":"Nano Banana Pro Preview","limit":{"context":65536,"output":32768},"modalities":{"input":["text","image"],"output":["text","image"]},"tool_call":false,"reasoning":true,"reasoning_options":[]},
  } },
  "aihubmix": { models: {
    "claude-opus-4-8": {"name":"Claude Opus 4.8","limit":{"context":200000,"output":32000},"modalities":{"input":["text","image"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[{"type":"toggle"},{"type":"effort","values":["low","medium","high","xhigh","max"]}]},
  } },
  "ambient": { api: "https://api.ambient.xyz/v1", models: {
    "moonshotai/kimi-k2.6": {"name":"Kimi K2.6","limit":{"context":262144,"output":262144},"modalities":{"input":["text","image"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[]},
  } },
  "anthropic": { models: {
    "claude-haiku-4-5": {"name":"Claude Haiku 4.5 (latest)","limit":{"context":200000,"output":64000},"modalities":{"input":["text","image","pdf"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[{"type":"budget_tokens","min":1024}]},
    "claude-opus-4-8": {"name":"Claude Opus 4.8","limit":{"context":1000000,"output":128000},"modalities":{"input":["text","image","pdf"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[{"type":"effort","values":["low","medium","high","xhigh","max"]}]},
    "claude-opus-5-5": {"name":"Claude Opus 5.5","limit":{"context":1000000,"output":128000},"modalities":{"input":["text","image","pdf"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[{"type":"effort","values":["low","medium","high","xhigh","max"]}]},
    "claude-sonnet-4-6": {"name":"Claude Sonnet 4.6","limit":{"context":1000000,"output":128000},"modalities":{"input":["text","image","pdf"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[{"type":"effort","values":["low","medium","high","max"]},{"type":"budget_tokens","min":1024}]},
  } },
  "anyapi": { api: "https://api.anyapi.ai/v1", models: {
    "mistralai/mistral-large-2512": {"name":"Mistral Large 3","limit":{"context":262144,"output":262144},"modalities":{"input":["text","image"],"output":["text"]},"tool_call":true,"reasoning":false},
  } },
  "azure": { models: {
    "deepseek-v4-pro": {"name":"DeepSeek-V4-Pro","limit":{"context":1000000,"output":384000},"modalities":{"input":["text"],"output":["text"]},"tool_call":false,"reasoning":true,"reasoning_options":[]},
    "gpt-5-pro": {"name":"GPT-5 Pro","limit":{"context":400000,"input":272000,"output":128000},"modalities":{"input":["text","image"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[{"type":"effort","values":["high"]}]},
  } },
  "azure-cognitive-services": { models: {
    "gpt-5-pro": {"name":"GPT-5 Pro","limit":{"context":400000,"input":272000,"output":128000},"modalities":{"input":["text","image"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[{"type":"effort","values":["high"]}]},
  } },
  "cortecs": { api: "https://api.cortecs.ai/v1", models: {
    "gemini-2.5-pro": {"name":"Gemini 2.5 Pro","limit":{"context":1048576,"output":65535},"modalities":{"input":["text","image","audio"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[]},
    "kimi-k2.6": {"name":"Kimi K2.6","limit":{"context":262144,"output":262144},"modalities":{"input":["text","image","pdf"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[{"type":"toggle"}]},
  } },
  "crossmodel": { api: "https://api.crossmodel.ai/v1", models: {
    "z-ai/glm-5.2": {"name":"GLM-5.2","limit":{"context":1000000,"output":128000},"modalities":{"input":["text"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[{"type":"toggle"}]},
  } },
  "deepinfra": { models: {
    "deepseek-ai/DeepSeek-V3": {"name":"DeepSeek-V3","limit":{"context":163840,"output":8192},"modalities":{"input":["text"],"output":["text"]},"tool_call":true,"reasoning":false},
  } },
  "deepseek": { api: "https://api.deepseek.com", models: {
    "deepseek-flash": {"name":"DeepSeek V4.1 Flash","limit":{"context":1000000,"output":393216},"modalities":{"input":["text","image"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[{"type":"toggle"},{"type":"effort","values":["low","high","max"]}]},
    "deepseek-v4-flash": {"name":"DeepSeek V4 Flash","limit":{"context":1000000,"output":393216},"modalities":{"input":["text","image"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[{"type":"toggle"},{"type":"effort","values":["low","high","max"]}]},
    "deepseek-v4-flash-vision-exp": {"name":"DeepSeek V4 Flash Vision Exp","limit":{"context":1000000,"output":393216},"modalities":{"input":["text","image"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[{"type":"toggle"},{"type":"effort","values":["low","high","max"]}]},
    "deepseek-v4-pro": {"name":"DeepSeek V4 Pro","limit":{"context":1000000,"output":393216},"modalities":{"input":["text"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[{"type":"toggle"},{"type":"effort","values":["low","high","max"]}]},
  } },
  "frogbot": { api: "https://app.frogbot.ai/api/v1", models: {
    "claude-sonnet-4-6": {"name":"Claude Sonnet 4.6","limit":{"context":200000,"output":64000},"modalities":{"input":["text","image","pdf"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[{"type":"effort","values":["low","medium","high"]},{"type":"budget_tokens","min":1024}]},
    "deepseek-v4-pro": {"name":"DeepSeek v4 Pro","limit":{"context":128000,"output":8192},"modalities":{"input":["text"],"output":["text"]},"tool_call":true,"reasoning":false},
  } },
  "google": { models: {
    "gemini-2.5-flash-image": {"name":"Nano Banana","limit":{"context":32768,"output":32768},"modalities":{"input":["text","image"],"output":["text","image"]},"tool_call":false,"reasoning":true,"reasoning_options":[]},
    "gemini-2.5-pro": {"name":"Gemini 2.5 Pro","limit":{"context":1048576,"output":65536},"modalities":{"input":["text","image","audio","video","pdf"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[{"type":"budget_tokens","min":128,"max":32768}]},
    "gemini-flash-latest": {"name":"Gemini Flash Latest","limit":{"context":1048576,"output":65536},"modalities":{"input":["text","image","video","audio","pdf"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[{"type":"effort","values":["low","medium","high"]}]},
    "gemma-4-31b-it": {"name":"Gemma 4 31B IT","limit":{"context":262144,"output":32768},"modalities":{"input":["text","image"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[{"type":"toggle"}]},
  } },
  "google-vertex": { models: {
    "gemini-2.5-flash-image": {"name":"Nano Banana","limit":{"context":32768,"output":32768},"modalities":{"input":["text","image"],"output":["text","image"]},"tool_call":false,"reasoning":false},
    "gemini-flash-latest": {"name":"Gemini Flash Latest","limit":{"context":1048576,"output":65536},"modalities":{"input":["text","image","video","audio","pdf"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[{"type":"effort","values":["minimal","low","medium","high"]}]},
  } },
  "helicone": { api: "https://ai-gateway.helicone.ai/v1", models: {
    "deepseek-reasoner": {"name":"DeepSeek Reasoner","limit":{"context":128000,"output":64000},"modalities":{"input":["text"],"output":["text"]},"tool_call":false,"reasoning":false},
    "gpt-5-pro": {"name":"OpenAI: GPT-5 Pro","limit":{"context":128000,"output":32768},"modalities":{"input":["text"],"output":["text"]},"tool_call":false,"reasoning":false},
    "grok-3": {"name":"xAI Grok 3","limit":{"context":131072,"output":131072},"modalities":{"input":["text"],"output":["text"]},"tool_call":true,"reasoning":false},
  } },
  "jiekou": { api: "https://api.jiekou.ai/openai", models: {
    "gemini-2.5-pro": {"name":"gemini-2.5-pro","limit":{"context":1048576,"output":65535},"modalities":{"input":["text","image","video","audio"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[{"type":"effort","values":["none","low","medium","high"]}]},
  } },
  "kilo": { api: "https://api.kilo.ai/api/gateway", models: {
    "mistralai/mistral-large-2512": {"name":"Mistral Large 3","limit":{"context":262144,"output":209715},"modalities":{"input":["text","image","pdf"],"output":["text"]},"tool_call":true,"reasoning":false},
    "moonshotai/kimi-k2.6": {"name":"Kimi K2.6","limit":{"context":262144,"output":235929},"modalities":{"input":["text","image"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[{"type":"effort","values":["none","high"]}]},
  } },
  "llmgateway": { api: "https://api.llmgateway.io/v1", models: {
    "gpt-3.5-turbo": {"name":"GPT-3.5-turbo","limit":{"context":16385,"output":4096},"modalities":{"input":["text"],"output":["text"]},"tool_call":false,"reasoning":false},
    "sonar": {"name":"Sonar","limit":{"context":130000,"output":4096},"modalities":{"input":["text"],"output":["text"]},"tool_call":false,"reasoning":false},
  } },
  "lmstudio": { api: "http://127.0.0.1:1234/v1", models: {
    "qwen/qwen3-coder-30b": {"name":"Qwen3 Coder 30B","limit":{"context":262144,"output":65536},"modalities":{"input":["text"],"output":["text"]},"tool_call":true,"reasoning":false},
  } },
  "melious": { api: "https://api.melious.ai/v1", models: {
    "kimi-k2.6": {"name":"Kimi K2.6","limit":{"context":256000,"output":256000},"modalities":{"input":["text","image","video"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[{"type":"effort","values":["none","high"]}]},
  } },
  "moonshotai-cn": { api: "https://api.moonshot.cn/v1", models: {
    "kimi-k2.6": {"name":"Kimi K2.6","limit":{"context":262144,"output":262144},"modalities":{"input":["text","image","video"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[{"type":"toggle"}]},
    "kimi-k3": {"name":"Kimi K3","limit":{"context":1048576,"output":1048576},"modalities":{"input":["text","image","video"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[{"type":"effort","values":["low","high","max"]}]},
  } },
  "nano-gpt": { api: "https://nano-gpt.com/api/v1", models: {
    "deepseek-reasoner": {"name":"DeepSeek Reasoner","limit":{"context":64000,"input":64000,"output":65536},"modalities":{"input":["text"],"output":["text"]},"tool_call":false,"reasoning":false},
    "doubao-seed-1-6-250615": {"name":"Doubao Seed 1.6","limit":{"context":256000,"input":256000,"output":16384},"modalities":{"input":["text"],"output":["text"]},"tool_call":false,"reasoning":false},
    "gemini-3-pro-image-preview": {"name":"Gemini 3 Pro Image","limit":{"context":65536,"input":65536,"output":32768},"modalities":{"input":["text","image"],"output":["text"]},"tool_call":false,"reasoning":false},
    "moonshotai/kimi-k2.6": {"name":"Kimi K2.6","limit":{"context":256000,"input":256000,"output":65536},"modalities":{"input":["text","image"],"output":["text"]},"tool_call":true,"reasoning":false},
    "z-ai/GLM-4.5-Air": {"name":"GLM 4.5 Air","limit":{"context":128000,"input":128000,"output":98304},"modalities":{"input":["text"],"output":["text"]},"tool_call":true,"reasoning":false},
  } },
  "neon": { api: "${NEON_AI_GATEWAY_BASE_URL}/v1", models: {
    "kimi-k3": {"name":"Kimi K3","limit":{"context":1048576,"output":65536},"modalities":{"input":["text","image","video"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[{"type":"toggle"},{"type":"effort","values":["none","minimal","low","medium","high","max"]}]},
  } },
  "openai": { models: {
    "gpt-3.5-turbo": {"name":"GPT-3.5-turbo","limit":{"context":16385,"output":4096},"modalities":{"input":["text"],"output":["text"]},"tool_call":false,"reasoning":false},
    "gpt-5-pro": {"name":"GPT-5 Pro","limit":{"context":400000,"input":272000,"output":272000},"modalities":{"input":["text","image"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[{"type":"effort","values":["high"]}]},
  } },
  "opencode": { api: "https://opencode.ai/zen/v1", models: {
    "glm-4.6": {"name":"GLM-4.6","limit":{"context":204800,"output":131072},"modalities":{"input":["text"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[{"type":"toggle"}]},
    "kimi-k2.6": {"name":"Kimi K2.6","limit":{"context":262144,"output":65536},"modalities":{"input":["text","image","video"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[{"type":"toggle"}]},
  } },
  "opencode-go": { api: "https://opencode.ai/zen/go/v1", models: {
    "kimi-k2.6": {"name":"Kimi K2.6","limit":{"context":262144,"output":65536},"modalities":{"input":["text","image","video"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[]},
  } },
  "openrouter": { api: "https://openrouter.ai/api/v1", models: {
    "mistralai/mistral-large-2512": {"name":"Mistral Large 3","limit":{"context":262144,"output":209715},"modalities":{"input":["text","image","pdf"],"output":["text"]},"tool_call":true,"reasoning":false},
    "moonshotai/kimi-k2.6": {"name":"Kimi K2.6","limit":{"context":262144,"output":235929},"modalities":{"input":["text","image"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[{"type":"toggle"}]},
    "openai/gpt-5.4": {"name":"GPT-5.4","limit":{"context":1050000,"input":922000,"output":128000},"modalities":{"input":["text","image","pdf"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[{"type":"effort","values":["none","low","medium","high","xhigh"]}]},
    "z-ai/glm-5.2": {"name":"GLM-5.2","limit":{"context":1048576,"output":943718},"modalities":{"input":["text"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[{"type":"toggle"},{"type":"effort","values":["high","xhigh"]}]},
  } },
  "opper": { api: "https://api.opper.ai/v3/compat", models: {
    "deepseek-v4-pro": {"name":"DeepSeek V4 Pro","limit":{"context":1000000,"output":65536},"modalities":{"input":["text"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[]},
    "gemma-4-31b-it": {"name":"Gemma 4 31B IT","limit":{"context":256000,"output":8192},"modalities":{"input":["text","image"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[]},
    "kimi-k3": {"name":"Kimi K3","limit":{"context":1048576,"output":131072},"modalities":{"input":["text"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[]},
    "sonar": {"name":"Sonar","limit":{"context":128000,"output":4096},"modalities":{"input":["text"],"output":["text"]},"tool_call":false,"reasoning":false},
  } },
  "perplexity": { models: {
    "sonar": {"name":"Sonar","limit":{"context":128000,"output":4096},"modalities":{"input":["text"],"output":["text"]},"tool_call":false,"reasoning":false},
  } },
  "pioneer": { api: "https://api.fastino.ai/v1", models: {
    "Qwen/Qwen3-32B": {"name":"Qwen3 32B","limit":{"context":131072,"output":8192},"modalities":{"input":["text"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[{"type":"effort","values":["low","medium","high"]}]},
    "deepseek-ai/DeepSeek-V3": {"name":"DeepSeek-V3","limit":{"context":163840,"output":8192},"modalities":{"input":["text"],"output":["text"]},"tool_call":true,"reasoning":false},
  } },
  "poe": { api: "https://api.poe.com/v1", models: {
    "openai/gpt-5.4": {"name":"GPT-5.4","limit":{"context":1050000,"input":922000,"output":128000},"modalities":{"input":["text","image","pdf"],"output":["image"]},"tool_call":true,"reasoning":true,"reasoning_options":[{"type":"effort","values":["none","low","medium","high","xhigh"]}]},
  } },
  "privatemode-ai": { api: "http://localhost:8080/v1", models: {
    "kimi-k2.6": {"name":"Kimi K2.6","limit":{"context":256000,"output":262144},"modalities":{"input":["text","image"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[{"type":"toggle"}]},
  } },
  "qiniu-ai": { api: "https://api.qnaigc.com/v1", models: {
    "gemini-2.5-flash-image": {"name":"Gemini 2.5 Flash Image","limit":{"context":32768,"output":8192},"modalities":{"input":["text","image"],"output":["image"]},"tool_call":false,"reasoning":false},
    "glm-4.5": {"name":"GLM 4.5","limit":{"context":131072,"output":98304},"modalities":{"input":["text"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[{"type":"toggle"}]},
  } },
  "requesty": { api: "https://router.requesty.ai/v1", models: {
    "claude-haiku-4-5": {"name":"Claude Haiku 4.5 (latest)","limit":{"context":200000,"output":64000},"modalities":{"input":["text","image","pdf"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[{"type":"effort","values":["none","low","medium","high","max"]}]},
    "gemma-4-31b-it": {"name":"Gemma 4 31B IT","limit":{"context":262144,"output":8192},"modalities":{"input":["text","image"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[{"type":"effort","values":["none","low","medium","high","max"]}]},
  } },
  "routing-run": { api: "https://api.routing.run/v1", models: {
    "claude-opus-4-8": {"name":"Claude Opus 4.8","limit":{"context":1000000,"output":32000},"modalities":{"input":["text","image","pdf"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[]},
  } },
  "sensenova": { api: "https://token.sensenova.cn/v1", models: {
    "deepseek-v4-pro": {"name":"DeepSeek V4 Pro","limit":{"context":1048576,"output":65536},"modalities":{"input":["text"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[{"type":"toggle"},{"type":"effort","values":["high","max"]}]},
    "kimi-k3": {"name":"Kimi K3","limit":{"context":1048576,"output":65536},"modalities":{"input":["text","image"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[{"type":"effort","values":["low","high","max"]}]},
  } },
  "siliconflow": { api: "https://api.siliconflow.com/v1", models: {
    "Qwen/Qwen3-32B": {"name":"Qwen/Qwen3-32B","limit":{"context":131000,"output":131000},"modalities":{"input":["text"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[{"type":"toggle"},{"type":"budget_tokens","min":128,"max":32768}]},
  } },
  "siliconflow-cn": { api: "https://api.siliconflow.cn/v1", models: {
    "Qwen/Qwen3-32B": {"name":"Qwen/Qwen3-32B","limit":{"context":131000,"output":131000},"modalities":{"input":["text"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[{"type":"toggle"},{"type":"budget_tokens","min":128,"max":32768}]},
    "deepseek-ai/DeepSeek-V3": {"name":"deepseek-ai/DeepSeek-V3","limit":{"context":164000,"output":164000},"modalities":{"input":["text"],"output":["text"]},"tool_call":true,"reasoning":false},
  } },
  "venice": { models: {
    "claude-opus-5-5": {"name":"Claude Opus 5.5","limit":{"context":1000000,"output":128000},"modalities":{"input":["text","image"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[{"type":"effort","values":["low","medium","high","xhigh","max"]}]},
    "claude-sonnet-4-6": {"name":"Claude Sonnet 4.6","limit":{"context":1000000,"output":64000},"modalities":{"input":["text","image"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[{"type":"effort","values":["low","medium","high","max"]}]},
    "kimi-k3": {"name":"Kimi K3","limit":{"context":1000000,"output":131072},"modalities":{"input":["text","image"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[{"type":"effort","values":["none","low","high","max"]}]},
  } },
  "vivgrid": { api: "https://api.vivgrid.com/v1", models: {
    "claude-opus-5-5": {"name":"Claude Opus 5.5","limit":{"context":1000000,"output":128000},"modalities":{"input":["text","image","pdf"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[{"type":"effort","values":["low","medium","high","xhigh","max"]}]},
    "kimi-k3": {"name":"Kimi K3","limit":{"context":1000000,"output":131072},"modalities":{"input":["text","image","pdf"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[]},
  } },
  "volcengine": { api: "https://ark.cn-beijing.volces.com/api/v3", models: {
    "deepseek-v4-flash-ga-260731": {"name":"DeepSeek V4 Flash 0731","limit":{"context":1000000,"output":384000},"modalities":{"input":["text"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[{"type":"toggle"},{"type":"effort","values":["minimal","low","medium","high"]}]},
  } },
  "xpersona": { api: "https://www.xpersona.co/v1", models: {
    "claude-haiku-4-5": {"name":"Claude Haiku 4.5 (latest)","limit":{"context":200000,"output":128000},"modalities":{"input":["text","image"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[{"type":"effort","values":["low","medium","high","xhigh","max"]}]},
    "claude-opus-4-8": {"name":"Claude Opus 4.8","limit":{"context":200000,"output":128000},"modalities":{"input":["text","image"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[{"type":"effort","values":["low","medium","high","xhigh","max"]}]},
    "claude-sonnet-4-6": {"name":"Claude Sonnet 4.6","limit":{"context":200000,"output":128000},"modalities":{"input":["text","image"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[{"type":"effort","values":["low","medium","high","xhigh","max"]}]},
  } },
  "zai": { api: "https://api.z.ai/api/paas/v4", models: {
    "glm-4.5": {"name":"GLM-4.5","limit":{"context":131072,"output":98304},"modalities":{"input":["text"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[{"type":"toggle"}]},
    "glm-4.6": {"name":"GLM-4.6","limit":{"context":204800,"output":131072},"modalities":{"input":["text"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[{"type":"toggle"}]},
  } },
  "zenmux": { api: "https://zenmux.ai/api/v1", models: {
    "moonshotai/kimi-k2.6": {"name":"Kimi K2.6","limit":{"context":262140,"output":262140},"modalities":{"input":["text","image","video"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[{"type":"toggle"}]},
    "openai/gpt-5.4": {"name":"GPT-5.4","limit":{"context":1050000,"output":128000},"modalities":{"input":["text","image"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[{"type":"effort","values":["low","medium","high"]}]},
    "z-ai/glm-5.2": {"name":"GLM 5.2","limit":{"context":1000000,"output":128000},"modalities":{"input":["text"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[{"type":"effort","values":["high","max"]}]},
  } },
  "zhipuai": { api: "https://open.bigmodel.cn/api/paas/v4", models: {
    "glm-4.5": {"name":"GLM-4.5","limit":{"context":131072,"output":98304},"modalities":{"input":["text"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[{"type":"toggle"}]},
    "glm-4.6": {"name":"GLM-4.6","limit":{"context":204800,"output":131072},"modalities":{"input":["text"],"output":["text"]},"tool_call":true,"reasoning":true,"reasoning_options":[{"type":"toggle"}]},
  } },
};

/** 每次调用给一份新的拷贝：测试改它不会影响别的用例。 */
export function snapshotExcerpt(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(EXCERPT)) as Record<string, unknown>;
}
