import type { AgentStreamEvent, ContentPart, StopReason } from '../../shared/types';
import {
  ProviderError, isThinkingBindingMessage, thinkingBindingMessage, type AgentProvider, type FetchLike, type StreamRequest,
} from './types';
import { parseSse } from './sse';

const CACHE = { type: 'ephemeral' } as const;
const BUDGETS = { low: 8192, medium: 32768, high: 65536 } as const;

/**
 * 思考块绑定到对话前缀的三个模型（W2a-3 · 设计稿 §2「新一代 Claude 缓解」）。按官方 model-migration 文档：
 *  - 思考关不掉：{type:'disabled'} 与 {type:'enabled', budget_tokens} 在任何 effort 下都 400，只能不写或写 adaptive；
 *  - 回放的思考块签名记着当时的对话前缀（system、tools、之前每条消息），前缀一变就 400「bound to a different conversation」。
 *    2026-08-31 之后注册的账号默认强制校验，而本仓每步重建系统提示、修剪滑窗、压缩保留回合都会改前缀。
 * 精确匹配：带日期后缀或别名的 id 不命中、维持旧行为——宁可漏掉一个别名，也不给没核实过的模型乱加 beta 字段。
 */
export const BINDING_MODELS: ReadonlySet<string> = new Set(['claude-fable-5-1', 'claude-mythos-5-1', 'claude-opus-5-5']);
/** 打开 block_binding 字段所需的 beta 头值。 */
const BINDING_BETA = 'thinking-binding-controls-2026-08-01';

/**
 * 是不是 Anthropic 官方端点：解析后要求 https 且主机名恰为 api.anthropic.com。
 * 不用 includes / endsWith：中转商的域名、路径、userinfo 里都可能带着这串字。解析不了的一律不算。
 * beta 头只在官方端点发：第三方中转不认这个头时，block_binding 字段会被判成多余字段而 400。
 */
export function isOfficialAnthropicEndpoint(baseUrl: string): boolean {
  try {
    const u = new URL(baseUrl);
    return u.protocol === 'https:' && u.hostname === 'api.anthropic.com';
  } catch { return false; }
}

/** 这次请求要不要带绑定控制（beta 头 + block_binding=drop_block）：官方端点上的三个目标模型。 */
export function anthropicBindingControls(baseUrl: string, modelId: string): boolean {
  return BINDING_MODELS.has(modelId) && isOfficialAnthropicEndpoint(baseUrl);
}

/** anthropic-beta 头按逗号合并去重。现在只有绑定控制一个值，留着这个口子，以后加别的 beta 不会互相覆盖。 */
export function mergeBetas(list: readonly string[]): string {
  return [...new Set(list.flatMap(s => s.split(',')).map(s => s.trim()).filter(s => s !== ''))].join(',');
}

export function buildAnthropicBody(req: StreamRequest, modelId: string, opts: { bindingControls?: boolean } = {}): Record<string, unknown> {
  // partToBlock 可能把整条消息的内容块全部丢弃（mediaRef-only 的既有隐患 + 不可回放 thinking-only
  // 的新形态：既无 signature 也无 redactedData 的历史思考块）。Anthropic 拒收 content 为空数组的
  // 消息，一条这样的历史消息会让该会话之后的每次请求都失败（永久变砖）。所以转成块后必须把
  // content 空的消息整条剔除。剔除必须发生在下方缓存断点标记之前：否则 cache_control 可能被
  // 打在这条即将被剔除的消息上，浪费缓存断点额度。
  const messages = req.messages
    .map(m => ({ role: m.role, content: m.parts.map(partToBlock).filter((b): b is Record<string, unknown> => b !== undefined) }))
    .filter(m => m.content.length > 0);
  let stamped = 0;
  for (let i = messages.length - 1; i >= 0 && stamped < 2; i--) {
    const c = messages[i].content;
    if (messages[i].role === 'user' && c.length > 0) { c[c.length - 1] = { ...c[c.length - 1], cache_control: CACHE }; stamped++; }
  }
  const tools = req.tools.map(t => ({
    name: t.name, description: t.description,
    // D5 MCP 工具带 rawInputSchema 时直用（嵌套结构原样透传给 Anthropic，不平铺不重排）；
    // 无该字段的内置工具走既有平铺路径——零影响。
    input_schema: t.rawInputSchema !== undefined ? t.rawInputSchema : {
      type: 'object',
      properties: Object.fromEntries(Object.entries(t.parameters).map(([k, p]) => [k, { type: p.type, description: p.description, ...(p.enumValues ? { enum: p.enumValues } : {}) }])),
      required: t.required,
    },
  })) as Record<string, unknown>[];
  if (tools.length > 0) tools[tools.length - 1] = { ...tools[tools.length - 1], cache_control: CACHE };
  const body: Record<string, unknown> = { model: modelId, max_tokens: req.maxTokens, stream: true, messages, tools };
  if (req.systemPrompt) body.system = [{ type: 'text', text: req.systemPrompt, cache_control: CACHE }];
  if (BINDING_MODELS.has(modelId)) {
    // 这三个模型不看 thinkingLevel、也不走下面「旧数据关思考」的分支：enabled+budget_tokens 与 disabled 都是 400。
    // 不写 thinking 就是 adaptive。官方端点显式写 drop_block：前缀对不上时服务端丢掉失效的思考块继续答，
    // 而不是 400（只带头时缺省也是 drop_block，但文档要求显式写，免得缺省值变了悄悄换行为）。
    // effort 映射（thinkingLevel → output_config.effort）留给 W4c。
    if (opts.bindingControls) body.thinking = { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } };
    return body;
  }
  if (req.thinkingLevel !== 'off') {
    // 旧数据兼容：老版本落库的 assistant 消息含 toolUse 但没存 thinking part。Anthropic 要求
    // 思考开启时带 tool_use 的 assistant 消息必须原样带回 thinking 块（含签名），缺了会在该
    // 会话后续每次请求上直接 400。这种历史消息无法补回签名，唯一出路是整请求降级关闭思考，
    // 否则整个会话永久变砖。只看最后一条 assistant：thinking 只跟最近一次工具交互相关。
    const lastAssistant = [...req.messages].reverse().find(m => m.role === 'assistant');
    const staleToolUse = lastAssistant !== undefined
      && lastAssistant.parts.some(p => p.type === 'toolUse')
      && !lastAssistant.parts.some(isReplayableThinking);
    if (!staleToolUse) {
      body.thinking = { type: 'enabled', budget_tokens: Math.min(BUDGETS[req.thinkingLevel], req.maxTokens - 1) };
    }
  }
  return body;
}

/** 该 thinking part 能否回放成 Anthropic 块：需有 signature（thinking 块校验签名）或
 *  redactedData（redacted_thinking 块原样回放脱敏串）。两者都缺的思考 part 会被 partToBlock
 *  丢弃，等于「没带 thinking 块」——这种情况与没有 thinking part 一样，思考开启时照样 400。 */
function isReplayableThinking(p: ContentPart): boolean {
  if (p.type !== 'thinking') return false;
  const v = p.value as { text: string; signature?: string; redactedData?: string };
  return v.signature !== undefined || v.redactedData !== undefined;
}

/** 剥掉全部思考 part 的请求副本（thinking part 回放成 thinking 或 redacted_thinking 块，两种一并去掉）。
 *  重建请求体而不是在 JSON 上删块：只剩思考的消息会被整条剔除；非目标模型开着思考时，末条 tool_use 没了思考块
 *  会走「旧数据关思考」的分支，免得剥完又撞上「思考开启时 tool_use 前必须有思考块」的 400。 */
function withoutThinking(req: StreamRequest): StreamRequest {
  return { ...req, messages: req.messages.map(m => ({ ...m, parts: m.parts.filter(p => p.type !== 'thinking') })) };
}

/** HTTP 错误 → ProviderError。绑定错误显式带 code 与中文说明（设计稿 §3 第 3 条），其余按状态码老规则推导。 */
function httpError(status: number, text: string): ProviderError {
  const raw = `Anthropic HTTP ${status}: ${text}`;
  return isThinkingBindingMessage(text, status)
    ? new ProviderError(thinkingBindingMessage(raw), { status, code: 'thinkingBinding' })
    : new ProviderError(raw, { status });
}

function partToBlock(p: ContentPart): Record<string, unknown> | undefined {
  switch (p.type) {
    case 'text': return { type: 'text', text: p.value as string };
    case 'imageData': {
      const v = p.value as { mimeType: string; base64: string };
      return { type: 'image', source: { type: 'base64', media_type: v.mimeType, data: v.base64 } };
    }
    case 'toolUse': {
      const v = p.value as { toolUseId: string; name: string; input: string };
      // 历史里一旦躺着非法 JSON（老版本落库 / 流被截断），裸 JSON.parse 会在该会话
      // 之后的每一次请求上抛 SyntaxError —— 会话永久变砖。降级成空对象，让模型看到
      // 「缺少必填参数」的工具错误后自行重试，比整条会话不可用要好。
      let parsed: unknown = {};
      try { parsed = JSON.parse(v.input || '{}'); } catch { parsed = {}; }
      return { type: 'tool_use', id: v.toolUseId, name: v.name, input: parsed };
    }
    case 'toolResult': {
      const v = p.value as { toolUseId: string; output: string; success: boolean };
      return { type: 'tool_result', tool_use_id: v.toolUseId, content: v.output, is_error: !v.success };
    }
    case 'thinking': {
      const v = p.value as { text: string; signature?: string; redactedData?: string };
      // 回放优先级：redactedData 是供应商已脱敏的完整块（无签名，原样回放）；否则必须有
      // signature 才能回放成 thinking 块（Anthropic 校验签名，缺失会 400）。两者都没有的
      // 历史 thinking 无法补签名，只能丢弃——与 Gemini 无签名降级同理，宁丢不改坏会话。
      if (v.redactedData !== undefined) return { type: 'redacted_thinking', data: v.redactedData };
      if (v.signature !== undefined) return { type: 'thinking', thinking: v.text, signature: v.signature };
      return undefined;
    }
    default: return undefined;
  }
}

// model_context_window_exceeded（W2a-1）：输出撞上窗口剩余空间而停，与 max_tokens 同属截断。
// 缺这个键会被下面的兜底落成 endTurn——压缩拿半截摘要当完整摘要写进 marker，续写逻辑也看不出被截断。
const STOP_MAP: Record<string, StopReason> = {
  end_turn: 'endTurn', tool_use: 'toolUse', max_tokens: 'maxTokens', refusal: 'refusal',
  model_context_window_exceeded: 'maxTokens',
};

export class AnthropicProvider implements AgentProvider {
  readonly name = 'anthropic';
  readonly modelId: string;
  private apiKey: string; private baseUrl: string; private fetchImpl: FetchLike;

  constructor(opts: { apiKey: string; modelId: string; baseUrl?: string; fetchImpl?: FetchLike }) {
    this.apiKey = opts.apiKey; this.modelId = opts.modelId;
    this.baseUrl = (opts.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private post(headers: Record<string, string>, body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    return this.fetchImpl(`${this.baseUrl}/v1/messages`, { method: 'POST', signal, headers, body: JSON.stringify(body) })
      .catch((e: unknown) => { throw new ProviderError(`网络错误: ${String(e)}`, { retryable: true }); });
  }

  async *streamAgentMessage(req: StreamRequest, signal?: AbortSignal): AsyncIterable<AgentStreamEvent> {
    const binding = anthropicBindingControls(this.baseUrl, this.modelId);
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' };
    if (binding) headers['anthropic-beta'] = mergeBetas([BINDING_BETA]);
    let res = await this.post(headers, buildAnthropicBody(req, this.modelId, { bindingControls: binding }), signal);
    if (!res.ok || !res.body) {
      const text = await res.text();
      // 没带 beta 头（第三方中转，或官方端点上的非目标 id）就没法让服务端 drop_block。官方文档的恢复法：
      // 剥掉历史里全部 thinking / redacted_thinking 块（text 与 tool_use 留着）重试一次——这一轮少了之前的推理，
      // 但会话能走下去；否则前缀每步都在变，这个会话之后的每次请求都是同一条 400。
      // 只重试一次：剥完仍是绑定错误说明问题不在这些块上，再发也一样。没有可回放的思考块时剥了还是同一个请求体，不白发
      if (!binding && isThinkingBindingMessage(text, res.status) && req.messages.some(m => m.parts.some(isReplayableThinking))) {
        res = await this.post(headers, buildAnthropicBody(withoutThinking(req), this.modelId), signal);
        if (!res.ok || !res.body) throw httpError(res.status, await res.text());
      } else {
        throw httpError(res.status, text);
      }
    }

    const blocks = new Map<number, { type: string; id?: string; name?: string; json: string; thinking: string; signature: string; redactedData: string }>();
    let inputTokens = 0; let outputTokens = 0; let stopReason: StopReason = 'endTurn';
    for await (const frame of parseSse(res.body)) {
      const ev = JSON.parse(frame.data) as Record<string, any>;
      switch (ev.type) {
        case 'message_start': inputTokens = ev.message?.usage?.input_tokens ?? 0; break;
        case 'content_block_start':
          // redacted_thinking 的脱敏串在 start 里一次性给出（无 delta），先存下供 stop 时回放
          blocks.set(ev.index, {
            type: ev.content_block.type, id: ev.content_block.id, name: ev.content_block.name, json: '',
            thinking: '', signature: '', redactedData: ev.content_block.type === 'redacted_thinking' ? String(ev.content_block.data ?? '') : '',
          });
          break;
        case 'content_block_delta': {
          const b = blocks.get(ev.index);
          if (ev.delta.type === 'text_delta') yield { kind: 'textDelta', text: ev.delta.text };
          else if (ev.delta.type === 'thinking_delta') {
            // thinking_delta 只透出展示事件；完整文本在 stop 时以 thinkingComplete 一次性给出，
            // 方便 loop 连同 signature 一起持久化。这里顺带累积，stop 时拼装。
            if (b) b.thinking += ev.delta.thinking;
            yield { kind: 'thinkingDelta', text: ev.delta.thinking };
          }
          else if (ev.delta.type === 'input_json_delta' && b) {
            b.json += ev.delta.partial_json;
            yield { kind: 'toolInputDelta', toolUseId: b.id ?? '', name: b.name ?? '', accumulatedJson: b.json };
          }
          else if (ev.delta.type === 'signature_delta' && b) b.signature += ev.delta.signature;
          break;
        }
        case 'content_block_stop': {
          const b = blocks.get(ev.index);
          if (b?.type === 'tool_use') yield { kind: 'toolCallComplete', toolUseId: b.id ?? '', name: b.name ?? '', input: b.json || '{}' };
          else if (b?.type === 'thinking') yield { kind: 'thinkingComplete', text: b.thinking, signature: b.signature || undefined, redactedData: undefined };
          else if (b?.type === 'redacted_thinking') yield { kind: 'thinkingComplete', text: '', signature: undefined, redactedData: b.redactedData };
          break;
        }
        case 'message_delta':
          if (ev.delta?.stop_reason) stopReason = STOP_MAP[ev.delta.stop_reason] ?? 'endTurn';
          outputTokens = ev.usage?.output_tokens ?? outputTokens;
          break;
        case 'message_stop':
          yield { kind: 'usage', usage: { inputTokens, outputTokens } };
          yield { kind: 'done', stopReason };
          return;
      }
    }
    throw new ProviderError('SSE 流提前结束', { retryable: true });
  }
}
