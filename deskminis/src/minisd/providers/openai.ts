import { sessionHeaders } from './session-headers';
import { outboundFetch } from '../net/outbound-fetch';
import type { AgentStreamEvent, ContentPart, StopReason } from '../../shared/types';
import { ProviderError, type AdapterBudgetRule, type AgentProvider, type FetchLike, type StreamRequest } from './types';
import { parseSse } from './sse';
import { OpenAIUsageAcc } from './usage';

/** F02：/chat/completions 的窗口约束。出处：DeepSeek 接口文档 create-chat-completion（2026-10-03 读取）——
 *  「The total length of input tokens and generated tokens is limited by the model's context length」。
 *  目录另给独立输入上限的型号（如官方 gpt-5：400,000 = 272,000 + 128,000）由 limitProfile 按目录资料叠加，不在这条规则里。 */
export const OPENAI_CHAT_BUDGET_RULE: AdapterBudgetRule = {
  window: 'shared',
  note: 'OpenAI 兼容接口的通行约束，DeepSeek 接口文档',
};

/** 持久化的 toolUse.input 可能是被截断/损坏的 JSON（旧数据或异常写入）。
 *  发给端点前校验一次：解析失败就回退成空对象，避免把坏 JSON 当 arguments 发出去。 */
function safeJsonArgs(s: string): string {
  try { JSON.parse(s || '{}'); return s || '{}'; } catch { return '{}'; }
}

/** OpenAI 兼容端点的行为开关（默认全开，保持 M1 行为）。 */
export interface OpenAICompatFlags {
  /** 缺省 true：发送 stream_options.include_usage（部分兼容端点不支持该字段） */
  includeStreamOptions?: boolean;
  /** 缺省 true：thinkingLevel 非 off 时发送 reasoning_effort（Ollama 的 OpenAI 端点不认识，会 400） */
  reasoningEffort?: boolean;
}

/**
 * 这个模型要不要在每条 assistant 历史上回放 reasoning_content（W2a-4 · 设计稿 §2「引擎」）。
 * DeepSeek V4 的思考模式在多轮工具调用里要求把推理原样带回，缺了就 400；pi 与 OpenMinis 各自踩到过。
 * 只认 deepseek-v4 族（开头或某段路径之后是 deepseek-v4，后面不再接数字）：
 *  - 命中 deepseek-v4、deepseek-v4-flash、deepseek-v4-pro、deepseek-ai/DeepSeek-V4-Pro、deepseek/deepseek-v4；
 *  - 不命中 deepseek-reasoner——旧推理模型反过来，输入里带 reasoning_content 就 400；
 *    也不命中 deepseek-chat、deepseek-v3.2、deepseek-v40。
 * 按模型名而不是按 baseUrl 判（pi 的做法是看 baseUrl 含 deepseek.com）：同一个官方端点上 reasoner 与 v4 并存，
 * 按端点判会把 reasoner 一起打开；中转与聚合端点上的 v4 也要回放。
 */
export function requiresReasoningContentEcho(modelId: string): boolean {
  return /(?:^|\/)deepseek-v4(?:$|[^0-9])/i.test(modelId);
}

export function buildOpenAIBody(req: StreamRequest, modelId: string, flags: OpenAICompatFlags = {}): Record<string, unknown> {
  const echoReasoning = requiresReasoningContentEcho(modelId);
  const messages: Record<string, unknown>[] = [];
  if (req.systemPrompt) messages.push({ role: 'system', content: req.systemPrompt });
  for (const m of req.messages) {
    const texts = m.parts.filter(p => p.type === 'text').map(p => p.value as string).join('');
    const toolUses = m.parts.filter(p => p.type === 'toolUse');
    const toolResults = m.parts.filter(p => p.type === 'toolResult');
    const images = m.parts.filter(p => p.type === 'imageData');
    if (m.role === 'assistant') {
      const msg: Record<string, unknown> = { role: 'assistant', content: texts || null };
      if (toolUses.length) msg.tool_calls = toolUses.map(p => {
        const v = p.value as { toolUseId: string; name: string; input: string };
        return { id: v.toolUseId, type: 'function', function: { name: v.name, arguments: safeJsonArgs(v.input) } };
      });
      // 全量回放（open_questions 第 6 条）：每条 assistant 都带，已捕获的原样带回，没捕获到的补空串。
      // 不只回放当前回合：那样上一回合的推理到下一回合就被换成空串，请求前缀跟着变，DeepSeek 的前缀缓存命不中。
      // 键写在最后，别的模型走不到这里——它们的请求体逐字节不变（tests/provider-body-golden.test.ts 钉着）。
      if (echoReasoning) msg.reasoning_content = m.reasoningContent ?? '';
      messages.push(msg);
    } else {
      // F05：tool 消息先于这条消息里的文本 / 图片。pairToolResults 把缺失结果的占位并进下一条 user 消息的最前面
      //（崩溃后用户接着提问、或结果消息被同步合并进来的对端消息隔开），同一条消息里就既有 toolResult 又有文本；
      // 以前先发 user 文本、再发 tool，得到 assistant(tool_calls) → user → tool，OpenAI 兼容端点以
      // 「tool_calls 后面必须紧跟对应的 tool 消息」拒绝，会话此后每次请求都 400。只有 toolResult 或只有文本的消息不受影响。
      for (const p of toolResults) {
        const v = p.value as { toolUseId: string; output: string };
        messages.push({ role: 'tool', tool_call_id: v.toolUseId, content: v.output });
      }
      // 含图时才切数组 content：老端点（部分 OpenAI 兼容网关/Ollama）对数组形态 content 支持参差，
      // 无图消息保持 string 形态是最保守的兼容面——只在必要时才启用新形态。
      if (images.length > 0) {
        const content: Record<string, unknown>[] = [];
        if (texts) content.push({ type: 'text', text: texts });
        for (const p of images) {
          const v = p.value as { mimeType: string; base64: string };
          content.push({ type: 'image_url', image_url: { url: `data:${v.mimeType};base64,${v.base64}` } });
        }
        messages.push({ role: 'user', content });
      } else if (texts) {
        messages.push({ role: 'user', content: texts });
      }
    }
  }
  const body: Record<string, unknown> = {
    model: modelId, stream: true, max_tokens: req.maxTokens, messages,
  };
  // 没有工具时不写 tools 键（F01）：OpenAI 对 tools: [] 直接 400（"[] is too short - 'tools'"）——
  // 不支持工具调用的槽位、压缩摘要与自动命名的请求都不带工具。有工具时键序与以前一致（golden 不变）
  if (req.tools.length > 0) {
    body.tools = req.tools.map(t => ({
      type: 'function',
      function: {
        name: t.name, description: t.description,
        // D5 MCP 工具带 rawInputSchema 时直用（嵌套结构原样透传，不平铺不重排）；
        // 无该字段的内置工具走既有平铺路径——零影响。
        parameters: t.rawInputSchema !== undefined ? t.rawInputSchema : {
          type: 'object',
          properties: Object.fromEntries(Object.entries(t.parameters).map(([k, p]) => [k, { type: p.type, description: p.description, ...(p.enumValues ? { enum: p.enumValues } : {}) }])),
          required: t.required,
        },
      },
    }));
  }
  if (flags.includeStreamOptions !== false) body.stream_options = { include_usage: true };
  // F01：运行时按当前端点目录声明的档位映射过的值（如只接受 low/high/max 时 medium → low）优先
  if (req.thinkingLevel !== 'off' && flags.reasoningEffort !== false) body.reasoning_effort = req.thinking?.effort ?? req.thinkingLevel;
  return body;
}

const FINISH_MAP: Record<string, StopReason> = { stop: 'endTurn', tool_calls: 'toolUse', length: 'maxTokens', content_filter: 'refusal' };

export class OpenAIProvider implements AgentProvider {
  readonly name = 'openai-compat';
  readonly modelId: string;
  private apiKey: string; private baseUrl: string; private fetchImpl: FetchLike;
  private compat: OpenAICompatFlags;

  constructor(opts: { apiKey: string; modelId: string; baseUrl: string; fetchImpl?: FetchLike; compat?: OpenAICompatFlags }) {
    this.apiKey = opts.apiKey; this.modelId = opts.modelId;
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? outboundFetch;
    this.compat = opts.compat ?? {};
  }

  async *streamAgentMessage(req: StreamRequest, signal?: AbortSignal): AsyncIterable<AgentStreamEvent> {
    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: 'POST', signal,
      // Ollama 等本地端点无 key：空 key 时跳过 authorization 头（部分前置代理对多余鉴权头 401）
      headers: { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}), ...sessionHeaders(this.baseUrl, req.session) },
      body: JSON.stringify(buildOpenAIBody(req, this.modelId, this.compat)),
    }).catch((e: unknown) => { throw new ProviderError(`网络错误: ${String(e)}`, { retryable: true }); });
    if (!res.ok || !res.body) throw new ProviderError(`OpenAI HTTP ${res.status}: ${await res.text()}`, { status: res.status });

    const calls = new Map<number, { id: string; name: string; args: string }>();
    // F02：用量取最后一次有效报告并按官方定义归一化（prompt_tokens 已含缓存、推理是 completion 的子集）
    const acc = new OpenAIUsageAcc();
    let stopReason: StopReason = 'endTurn';
    let sawFinish = false;
    let sawDone = false;
    for await (const frame of parseSse(res.body)) {
      if (frame.data === '[DONE]') { sawDone = true; break; }
      const chunk = JSON.parse(frame.data) as Record<string, any>;
      acc.observe(chunk.usage);
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      if (typeof delta.content === 'string' && delta.content) yield { kind: 'textDelta', text: delta.content };
      // DeepSeek/Kimi/GLM 的推理模型走 OpenAI 兼容层时，思考内容在 delta.reasoning_content
      // 而非 content。不读它的话 loop 侧的 reasoningContent 永远为空——用户付了推理
      // token 的钱，界面上却什么都看不到。空串跳过：与 content 同规，空帧只是占位。
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) yield { kind: 'thinkingDelta', text: delta.reasoning_content };
      for (const tc of delta.tool_calls ?? []) {
        const cur = calls.get(tc.index) ?? { id: '', name: '', args: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name = tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        calls.set(tc.index, cur);
        yield { kind: 'toolInputDelta', toolUseId: cur.id, name: cur.name, accumulatedJson: cur.args };
      }
      if (choice.finish_reason) { stopReason = FINISH_MAP[choice.finish_reason] ?? 'endTurn'; sawFinish = true; }
    }
    if (!sawFinish && !sawDone) throw new ProviderError('SSE 流提前结束', { retryable: true });
    if (!sawFinish && calls.size > 0) stopReason = 'toolUse';
    for (const c of [...calls.values()]) {
      yield { kind: 'toolCallComplete', toolUseId: c.id, name: c.name, input: c.args || '{}' };
    }
    // 端点没报 usage（不认 stream_options、流被截在末帧之前）时不发 usage 事件：0/0 会被当成真实用量落库
    const usage = acc.result();
    if (usage) yield { kind: 'usage', usage };
    yield { kind: 'done', stopReason };
  }
}
