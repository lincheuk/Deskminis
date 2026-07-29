import type { AgentMessage, AgentStreamEvent, AgentToolDefinition, ThinkingLevel } from '../../shared/types';

export interface StreamRequest {
  messages: AgentMessage[];
  systemPrompt?: string;
  tools: AgentToolDefinition[];
  maxTokens: number;
  thinkingLevel: ThinkingLevel;
}

export interface AgentProvider {
  readonly name: string;
  readonly modelId: string;
  streamAgentMessage(req: StreamRequest, signal?: AbortSignal): AsyncIterable<AgentStreamEvent>;
}

export class ProviderError extends Error {
  status?: number;
  retryable: boolean;
  fallbackable: boolean;
  constructor(message: string, opts: { status?: number; retryable?: boolean; fallbackable?: boolean } = {}) {
    super(message);
    this.status = opts.status;
    // 同模型透明重试：网络抖动与网关/过载类 5xx（M1 语义不变）
    this.retryable = opts.retryable ?? (opts.status !== undefined && [500, 502, 503, 504, 529].includes(opts.status));
    // 立刻降级到模型组下一成员：限流(429)、无效/无权 key(401/403)、provider 侧请求错误(400/404/422)
    this.fallbackable = opts.fallbackable ?? (opts.status !== undefined && [400, 401, 403, 404, 422, 429].includes(opts.status));
  }
}

/** 同模型重试（M1 重试梯）。 */
export function isRetryable(e: unknown): boolean {
  return e instanceof ProviderError && e.retryable;
}

/** 立刻降级到模型组下一成员（限流/无效 key/provider 错误）。 */
export function isFallbackable(e: unknown): boolean {
  return e instanceof ProviderError && e.fallbackable;
}

export type FetchLike = typeof fetch;
