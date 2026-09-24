import type { AgentMessage, AgentStreamEvent, AgentToolDefinition, ThinkingLevel } from '../../shared/types';
import { isContextOverflowMessage } from './overflow';

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

/**
 * 错误分类码（W2a-2 · 设计稿 §3 第 1 条，联合在这一步一次定型）：
 *  - contextOverflow：上下文超窗。换同样大的模型没用，loop 只降级到窗口更大的槽位，否则报「上下文已满」；
 *  - thinkingBinding：Claude 拒绝回放绑定到别的对话的思考块。换模型解决不了，loop 直接报错（分类在 W2a-3）。
 * 两者缺省都既不降级也不重试；loop 还要在捕获处按 code 显式拦截——只把 fallbackable 设成 false 挡不住，
 * 非 fallbackable 且非 retryable 的错误只要链上还有下一槽位也会降级。
 */
export type ProviderErrorCode = 'contextOverflow' | 'thinkingBinding';

export class ProviderError extends Error {
  status?: number;
  retryable: boolean;
  fallbackable: boolean;
  code?: ProviderErrorCode;
  constructor(message: string, opts: { status?: number; retryable?: boolean; fallbackable?: boolean; code?: ProviderErrorCode } = {}) {
    super(message);
    this.status = opts.status;
    // 分类码：构造点显式给出优先；没给时按报文推导（HTTP 错误把响应体拼进了 message，四个构造点不必各认一遍）
    this.code = opts.code ?? (isContextOverflowMessage(message, opts.status) ? 'contextOverflow' : undefined);
    const coded = this.code !== undefined;
    // 同模型透明重试：网络抖动与网关/过载类 5xx（M1 语义不变）；带分类码的原样再发一次也是同样结果
    this.retryable = opts.retryable ?? (!coded && opts.status !== undefined && [500, 502, 503, 504, 529].includes(opts.status));
    // 立刻降级到模型组下一成员：限流(429)、无效/无权 key(401/403)、provider 侧请求错误(400/404/422)。
    // 超窗的 400 以前也落在这里——下一个成员窗口一样大就再白打一次 400，整条链烧完报「所有模型均不可用」
    this.fallbackable = opts.fallbackable ?? (!coded && opts.status !== undefined && [400, 401, 403, 404, 422, 429].includes(opts.status));
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
