import type { AgentStreamEvent, ContentPart, StopReason } from '../../shared/types';
import { ProviderError, type AgentProvider, type FetchLike, type StreamRequest } from './types';
import { parseSse } from './sse';

const CACHE = { type: 'ephemeral' } as const;
const BUDGETS = { low: 8192, medium: 32768, high: 65536 } as const;

export function buildAnthropicBody(req: StreamRequest, modelId: string): Record<string, unknown> {
  const messages = req.messages.map(m => ({ role: m.role, content: m.parts.map(partToBlock).filter((b): b is Record<string, unknown> => b !== undefined) }));
  let stamped = 0;
  for (let i = messages.length - 1; i >= 0 && stamped < 2; i--) {
    const c = messages[i].content;
    if (messages[i].role === 'user' && c.length > 0) { c[c.length - 1] = { ...c[c.length - 1], cache_control: CACHE }; stamped++; }
  }
  const tools = req.tools.map(t => ({
    name: t.name, description: t.description,
    input_schema: {
      type: 'object',
      properties: Object.fromEntries(Object.entries(t.parameters).map(([k, p]) => [k, { type: p.type, description: p.description, ...(p.enumValues ? { enum: p.enumValues } : {}) }])),
      required: t.required,
    },
  })) as Record<string, unknown>[];
  if (tools.length > 0) tools[tools.length - 1] = { ...tools[tools.length - 1], cache_control: CACHE };
  const body: Record<string, unknown> = { model: modelId, max_tokens: req.maxTokens, stream: true, messages, tools };
  if (req.systemPrompt) body.system = [{ type: 'text', text: req.systemPrompt, cache_control: CACHE }];
  if (req.thinkingLevel !== 'off') {
    body.thinking = { type: 'enabled', budget_tokens: Math.min(BUDGETS[req.thinkingLevel], req.maxTokens - 1) };
  }
  return body;
}

function partToBlock(p: ContentPart): Record<string, unknown> | undefined {
  switch (p.type) {
    case 'text': return { type: 'text', text: p.value as string };
    case 'toolUse': {
      const v = p.value as { toolUseId: string; name: string; input: string };
      return { type: 'tool_use', id: v.toolUseId, name: v.name, input: JSON.parse(v.input || '{}') };
    }
    case 'toolResult': {
      const v = p.value as { toolUseId: string; output: string; success: boolean };
      return { type: 'tool_result', tool_use_id: v.toolUseId, content: v.output, is_error: !v.success };
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

    const blocks = new Map<number, { type: string; id?: string; name?: string; json: string }>();
    let inputTokens = 0; let outputTokens = 0; let stopReason: StopReason = 'endTurn';
    for await (const frame of parseSse(res.body)) {
      const ev = JSON.parse(frame.data) as Record<string, any>;
      switch (ev.type) {
        case 'message_start': inputTokens = ev.message?.usage?.input_tokens ?? 0; break;
        case 'content_block_start':
          blocks.set(ev.index, { type: ev.content_block.type, id: ev.content_block.id, name: ev.content_block.name, json: '' });
          break;
        case 'content_block_delta': {
          const b = blocks.get(ev.index);
          if (ev.delta.type === 'text_delta') yield { kind: 'textDelta', text: ev.delta.text };
          else if (ev.delta.type === 'thinking_delta') yield { kind: 'thinkingDelta', text: ev.delta.thinking };
          else if (ev.delta.type === 'input_json_delta' && b) {
            b.json += ev.delta.partial_json;
            yield { kind: 'toolInputDelta', toolUseId: b.id ?? '', name: b.name ?? '', accumulatedJson: b.json };
          }
          break;
        }
        case 'content_block_stop': {
          const b = blocks.get(ev.index);
          if (b?.type === 'tool_use') yield { kind: 'toolCallComplete', toolUseId: b.id ?? '', name: b.name ?? '', input: b.json || '{}' };
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
