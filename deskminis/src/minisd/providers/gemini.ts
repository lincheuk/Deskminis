import { randomUUID } from 'node:crypto';
import type { AgentStreamEvent, ContentPart, StopReason, ThinkingLevel } from '../../shared/types';
import { ProviderError, type AgentProvider, type FetchLike, type StreamRequest } from './types';
import { parseSse } from './sse';

const BUDGETS: Record<Exclude<ThinkingLevel, 'off'>, number> = { low: 4096, medium: 16384, high: 24576 };

interface GeminiPart {
  text?: string;
  thought?: boolean;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
  thoughtSignature?: string;
}

interface ToolUseValue { toolUseId: string; name: string; input: string; thoughtSignature?: string }

/**
 * 历史回放规则（设计 §4.1 Gemini 段）：
 * - 带 thoughtSignature 的 toolUse → functionCall part 原样回放签名；
 * - 无签名的历史 toolUse 不能回放成 functionCall（Gemini 3 校验签名会 400），
 *   连同它配对的 toolResult 一起降级为文本摘要 part。
 * toolResult 自身不存工具名，functionResponse.name 从前面已见的 toolUse 反查。
 */
export function buildGeminiBody(req: StreamRequest, modelId: string): Record<string, unknown> {
  // 第一遍：收集无签名 toolUseId + toolUseId → 工具名映射
  const unsignedIds = new Set<string>();
  const nameById = new Map<string, string>();
  for (const m of req.messages) for (const p of m.parts) {
    if (p.type !== 'toolUse') continue;
    const v = p.value as ToolUseValue;
    nameById.set(v.toolUseId, v.name);
    if (!v.thoughtSignature) unsignedIds.add(v.toolUseId);
  }

  const contents = req.messages.map(m => {
    const role = m.role === 'assistant' ? 'model' : 'user';
    const parts: GeminiPart[] = [];
    for (const p of m.parts) {
      switch (p.type) {
        case 'text':
          parts.push({ text: p.value as string });
          break;
        case 'toolUse': {
          const v = p.value as ToolUseValue;
          if (unsignedIds.has(v.toolUseId)) {
            parts.push({ text: `[历史工具调用] ${v.name} 参数: ${v.input}` });
            break;
          }
          // 与 M1 anthropic partToBlock 同理：历史里的非法 JSON 裸 parse 会让该会话之后
          // 每次请求都抛 SyntaxError（永久变砖）。降级为空对象参数。
          let args: Record<string, unknown> = {};
          try {
            const parsed: unknown = JSON.parse(v.input || '{}');
            if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
          } catch { args = {}; }
          const part: GeminiPart = { functionCall: { name: v.name, args } };
          if (v.thoughtSignature) part.thoughtSignature = v.thoughtSignature;
          parts.push(part);
          break;
        }
        case 'toolResult': {
          const v = p.value as { toolUseId: string; output: string; success: boolean };
          if (unsignedIds.has(v.toolUseId)) {
            parts.push({ text: `[历史工具结果] ${v.success ? '成功' : '失败'}: ${v.output}` });
            break;
          }
          parts.push({ functionResponse: { name: nameById.get(v.toolUseId) ?? '', response: { result: v.output } } });
          break;
        }
        default:
          break; // mediaRef 等类型 Gemini 路径暂不处理（M2a/UI 子计划范围）
      }
    }
    return { role, parts };
  }).filter(c => c.parts.length > 0); // Gemini 拒收空 content

  const body: Record<string, unknown> = { contents };
  if (req.systemPrompt) body.system_instruction = { parts: [{ text: req.systemPrompt }] };
  if (req.tools.length > 0) {
    body.tools = [{
      functionDeclarations: req.tools.map(t => ({
        name: t.name, description: t.description,
        parameters: {
          type: 'object',
          properties: Object.fromEntries(Object.entries(t.parameters).map(([k, p]) => [k, { type: p.type.toUpperCase(), description: p.description, ...(p.enumValues ? { enum: p.enumValues } : {}) }])),
          required: t.required,
        },
      })),
    }];
  }
  const generationConfig: Record<string, unknown> = { maxOutputTokens: req.maxTokens };
  if (req.thinkingLevel !== 'off') {
    generationConfig.thinkingConfig = { thinkingBudget: Math.min(BUDGETS[req.thinkingLevel], req.maxTokens - 1), includeThoughts: true };
  }
  body.generationConfig = generationConfig;
  return body;
}

const FINISH_MAP: Record<string, StopReason> = { STOP: 'endTurn', MAX_TOKENS: 'maxTokens', SAFETY: 'refusal', RECITATION: 'refusal', OTHER: 'refusal' };

export class GeminiProvider implements AgentProvider {
  readonly name = 'gemini';
  readonly modelId: string;
  private apiKey: string; private baseUrl: string; private fetchImpl: FetchLike;

  constructor(opts: { apiKey: string; modelId: string; baseUrl?: string; fetchImpl?: FetchLike }) {
    this.apiKey = opts.apiKey; this.modelId = opts.modelId;
    this.baseUrl = (opts.baseUrl ?? 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async *streamAgentMessage(req: StreamRequest, signal?: AbortSignal): AsyncIterable<AgentStreamEvent> {
    const url = `${this.baseUrl}/v1beta/models/${encodeURIComponent(this.modelId)}:streamGenerateContent?alt=sse`;
    const res = await this.fetchImpl(url, {
      method: 'POST', signal,
      // 密钥放 header 而非 query key=：URL 会进代理/错误日志
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify(buildGeminiBody(req, this.modelId)),
    }).catch((e: unknown) => { throw new ProviderError(`网络错误: ${String(e)}`, { retryable: true }); });
    if (!res.ok || !res.body) throw new ProviderError(`Gemini HTTP ${res.status}: ${await res.text()}`, { status: res.status });

    let inputTokens = 0; let outputTokens = 0;
    let stopReason: StopReason = 'endTurn';
    let sawFinish = false; let sawUsage = false; let sawToolCall = false;
    for await (const frame of parseSse(res.body)) {
      const chunk = JSON.parse(frame.data) as Record<string, any>;
      if (chunk.usageMetadata) {
        inputTokens = chunk.usageMetadata.promptTokenCount ?? inputTokens;
        outputTokens = chunk.usageMetadata.candidatesTokenCount ?? outputTokens;
        sawUsage = true;
      }
      if (typeof chunk.promptFeedback?.blockReason === 'string') {
        yield { kind: 'usage', usage: { inputTokens, outputTokens } };
        yield { kind: 'done', stopReason: 'refusal' };
        return;
      }
      const cand = chunk.candidates?.[0];
      if (!cand) continue;
      for (const part of (cand.content?.parts ?? []) as Record<string, any>[]) {
        if (part.thought === true && typeof part.text === 'string') { yield { kind: 'thinkingDelta', text: part.text }; continue; }
        if (typeof part.text === 'string' && part.text) { yield { kind: 'textDelta', text: part.text }; continue; }
        if (part.functionCall) {
          sawToolCall = true;
          yield {
            kind: 'toolCallComplete',
            // Gemini 的函数调用整体到达且不给调用 id：合成 UUID（对齐全局 ID 大写约定）
            toolUseId: randomUUID().toUpperCase(),
            name: String(part.functionCall.name ?? ''),
            input: JSON.stringify(part.functionCall.args ?? {}),
            ...(typeof part.thoughtSignature === 'string' ? { thoughtSignature: part.thoughtSignature } : {}),
          };
        }
      }
      if (cand.finishReason) { stopReason = FINISH_MAP[cand.finishReason as string] ?? 'endTurn'; sawFinish = true; }
    }
    if (!sawFinish && !sawUsage) throw new ProviderError('SSE 流提前结束', { retryable: true });
    if (sawToolCall) stopReason = 'toolUse';
    yield { kind: 'usage', usage: { inputTokens, outputTokens } };
    yield { kind: 'done', stopReason };
  }
}
