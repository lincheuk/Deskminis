import type { AgentStreamEvent, ContentPart, StopReason } from '../../shared/types';
import { ProviderError, type AgentProvider, type FetchLike, type StreamRequest } from './types';
import { parseSse } from './sse';

const CACHE = { type: 'ephemeral' } as const;
const BUDGETS = { low: 8192, medium: 32768, high: 65536 } as const;

export function buildAnthropicBody(req: StreamRequest, modelId: string): Record<string, unknown> {
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

const STOP_MAP: Record<string, StopReason> = { end_turn: 'endTurn', tool_use: 'toolUse', max_tokens: 'maxTokens', refusal: 'refusal' };

export class AnthropicProvider implements AgentProvider {
  readonly name = 'anthropic';
  readonly modelId: string;
  private apiKey: string; private baseUrl: string; private fetchImpl: FetchLike;

  constructor(opts: { apiKey: string; modelId: string; baseUrl?: string; fetchImpl?: FetchLike }) {
    this.apiKey = opts.apiKey; this.modelId = opts.modelId;
    this.baseUrl = (opts.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async *streamAgentMessage(req: StreamRequest, signal?: AbortSignal): AsyncIterable<AgentStreamEvent> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(buildAnthropicBody(req, this.modelId)),
    }).catch((e: unknown) => { throw new ProviderError(`网络错误: ${String(e)}`, { retryable: true }); });
    if (!res.ok || !res.body) throw new ProviderError(`Anthropic HTTP ${res.status}: ${await res.text()}`, { status: res.status });

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
