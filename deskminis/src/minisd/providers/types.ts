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
 *  - thinkingBinding：Claude 拒绝回放绑定到别的对话的思考块（W2a-3）。绑定的是这段对话的历史，换模型解决不了，loop 直接报错。
 * 两者缺省都既不降级也不重试；loop 还要在捕获处按 code 显式拦截——只把 fallbackable 设成 false 挡不住，
 * 非 fallbackable 且非 retryable 的错误只要链上还有下一槽位也会降级。
 */
export type ProviderErrorCode = 'contextOverflow' | 'thinkingBinding';

/** 绑定错误中文说明的开头。渲染端的错误短句会把长文案截到 80 字，所以说明必须排在原始报文前面。 */
export const THINKING_BINDING_LEAD = 'Claude 拒绝回放历史思考块';

/**
 * 这条报错是不是「思考块绑定到了别的对话」（W2a-3）。特征句取自官方 model-migration 文档给出的 400 原文
 * 「The block is bound to a different conversation」——签名被篡改是另一种 400，没有这句，也不归这里。
 * 状态闸与超窗判定同理：429 是限流、5xx 是服务端故障，响应体里碰巧带这句也不改变它们原来的处理。
 */
export function isThinkingBindingMessage(message: string, status?: number): boolean {
  if (status !== undefined && (status === 429 || status >= 500)) return false;
  return /bound to a different conversation/i.test(message);
}

/**
 * 绑定错误的 message（设计稿 §3 第 3 条）：中文说明在前、原始错误在后。
 * 已经带中文说明的原样返回——包好的 message 再构造一次 ProviderError 不会叠两层。
 */
export function thinkingBindingMessage(raw: string): string {
  if (raw.startsWith(THINKING_BINDING_LEAD)) return raw;
  return `${THINKING_BINDING_LEAD}：对话前缀校验未通过，换模型无法解决。请新建会话继续；如在用第三方中转，可改用官方端点。（原始错误：${raw}）`;
}

/** 没显式给分类码时按报文推导。绑定句更具体，先认它。 */
function deriveCode(message: string, status?: number): ProviderErrorCode | undefined {
  if (isThinkingBindingMessage(message, status)) return 'thinkingBinding';
  if (isContextOverflowMessage(message, status)) return 'contextOverflow';
  return undefined;
}

export class ProviderError extends Error {
  status?: number;
  retryable: boolean;
  fallbackable: boolean;
  code?: ProviderErrorCode;
  constructor(message: string, opts: { status?: number; retryable?: boolean; fallbackable?: boolean; code?: ProviderErrorCode } = {}) {
    // 推导出绑定错误时顺手补上中文说明：OpenAI 兼容中转会把 Claude 的这条 400 原样转发，loop 直接把 message
    // 交给界面，不补的话用户只看到一段英文 JSON。显式给了 code 的构造点自己负责文案，这里不动
    const derived = opts.code === undefined ? deriveCode(message, opts.status) : undefined;
    super(derived === 'thinkingBinding' ? thinkingBindingMessage(message) : message);
    this.status = opts.status;
    // 分类码：构造点显式给出优先；没给时按报文推导（HTTP 错误把响应体拼进了 message，四个构造点不必各认一遍）
    this.code = opts.code ?? derived;
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
