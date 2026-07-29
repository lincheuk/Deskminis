import type { AgentStreamEvent, ContentPart, StopReason } from '../../shared/types';
import { ProviderError, type AgentProvider, type FetchLike, type StreamRequest } from './types';
import { parseSse } from './sse';

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

export function buildOpenAIBody(req: StreamRequest, modelId: string, flags: OpenAICompatFlags = {}): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];
  if (req.systemPrompt) messages.push({ role: 'system', content: req.systemPrompt });
  for (const m of req.messages) {
    const texts = m.parts.filter(p => p.type === 'text').map(p => p.value as string).join('');
    const toolUses = m.parts.filter(p => p.type === 'toolUse');
    const toolResults = m.parts.filter(p => p.type === 'toolResult');
    if (m.role === 'assistant') {
      const msg: Record<string, unknown> = { role: 'assistant', content: texts || null };
      if (toolUses.length) msg.tool_calls = toolUses.map(p => {
        const v = p.value as { toolUseId: string; name: string; input: string };
        return { id: v.toolUseId, type: 'function', function: { name: v.name, arguments: safeJsonArgs(v.input) } };
      });
      messages.push(msg);
    } else {
      if (texts) messages.push({ role: 'user', content: texts });
      for (const p of toolResults) {
        const v = p.value as { toolUseId: string; output: string };
        messages.push({ role: 'tool', tool_call_id: v.toolUseId, content: v.output });
      }
    }
  }
  const body: Record<string, unknown> = {
    model: modelId, stream: true, max_tokens: req.maxTokens, messages,
    tools: req.tools.map(t => ({
      type: 'function',
      function: {
        name: t.name, description: t.description,
        parameters: {
          type: 'object',
          properties: Object.fromEntries(Object.entries(t.parameters).map(([k, p]) => [k, { type: p.type, description: p.description, ...(p.enumValues ? { enum: p.enumValues } : {}) }])),
          required: t.required,
        },
      },
    })),
  };
  if (flags.includeStreamOptions !== false) body.stream_options = { include_usage: true };
  if (req.thinkingLevel !== 'off' && flags.reasoningEffort !== false) body.reasoning_effort = req.thinkingLevel;
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
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.compat = opts.compat ?? {};
  }

  async *streamAgentMessage(req: StreamRequest, signal?: AbortSignal): AsyncIterable<AgentStreamEvent> {
    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: 'POST', signal,
      // Ollama 等本地端点无 key：空 key 时跳过 authorization 头（部分前置代理对多余鉴权头 401）
      headers: { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify(buildOpenAIBody(req, this.modelId, this.compat)),
    }).catch((e: unknown) => { throw new ProviderError(`网络错误: ${String(e)}`, { retryable: true }); });
    if (!res.ok || !res.body) throw new ProviderError(`OpenAI HTTP ${res.status}: ${await res.text()}`, { status: res.status });

    const calls = new Map<number, { id: string; name: string; args: string }>();
    let usage = { inputTokens: 0, outputTokens: 0 };
    let stopReason: StopReason = 'endTurn';
    let sawFinish = false;
    let sawDone = false;
    for await (const frame of parseSse(res.body)) {
      if (frame.data === '[DONE]') { sawDone = true; break; }
      const chunk = JSON.parse(frame.data) as Record<string, any>;
      if (chunk.usage) usage = { inputTokens: chunk.usage.prompt_tokens ?? 0, outputTokens: chunk.usage.completion_tokens ?? 0 };
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      if (typeof delta.content === 'string' && delta.content) yield { kind: 'textDelta', text: delta.content };
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
    yield { kind: 'usage', usage };
    yield { kind: 'done', stopReason };
  }
}
