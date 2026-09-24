import type { AgentMessage } from '../../shared/types';

export type ContextAction = 'none' | 'offload' | 'compact';

/** 模型窗口未知时的保守回退窗口。M4.5：32K → 128K（避免落入「只 offload 不 compact」陷阱档，2026 年主流模型 ≥128K）。
 *  W2a-1 起导出：压缩预算与溢出降级都要按同一个窗口判定，各抄一份常量迟早对不上。 */
export const FALLBACK_WINDOW = 128_000;

/** CJK 范围沿用 tools/memory.ts 的 [\u4e00-\u9fa5]。 */
const CJK = /[\u4e00-\u9fa5]/g;

/** 粗估一段文本的 token 数：CJK 字符按 /1.6，其余字符按 /4，向上取整。
 *  换算依据：英文约 4 字符/token，中文约 1.5–2 字符/token。
 *  旧实现整体 /4，把中文按英文密度折算，得真实值的一半（低估）→ 水位显示偏低、
 *  压缩触发过晚，中文密集的长会话会直接撞上下文上限；故 CJK 必须用更小的除数
 *  （1.6）单独折算，使其贴近真实值。
 *  W2a-1 抽成导出函数：压缩要给「摘要请求本身」算预算，那是一段纯文本而不是 parts 数组；
 *  与水位估算共用同一公式，两边的口径才一致。字符数与 CJK 数对拼接可加，
 *  所以分段估算再相加只会比整体估算略大（每段向上取整），用来卡预算是偏保守的一侧。 */
export function estimateTextTokens(s: string): number {
  const cjk = (s.match(CJK) ?? []).length;
  return Math.ceil(cjk / 1.6 + (s.length - cjk) / 4);
}

/**
 * 上下文水位检查（设计 §4.2「上下文水位检查」段）。
 * 消费 M2b ModelCatalog.getModelContextWindow，按窗口分层决策。
 *
 * 注意：estimateTokens 的入参是 AgentMessage[]（不是 RawMessage[]）——
 * 水位检查在 loop.ts 里发生在 buildEffectiveHistory 之后，估算只算 parts JSON 的字符数。
 * W2a-4 起 assistant 的 reasoningContent 也进了 AgentMessage（DeepSeek V4 要回放），但这里仍然不数它：
 * 有意保留——它只对 v4 族真的发出去，对别的模型数进去反而高估；代价是 v4 会话的水位偏低，
 * W5 改为以真实 usage 为锚时一并解决。
 */
export class ContextPolicy {
  constructor(private catalog: { getModelContextWindow(modelId: string): number | undefined }) {}

  /** 粗估 token 数：各条 parts JSON 拼接后按 estimateTextTokens 估算（公式见上）。
   *  拼接后只取整一次，与旧实现「累加字符数与 CJK 数、最后取整一次」逐值相同——
   *  JSON 壳与英文/数字/标点计入总数但不算 CJK，各自用各自密度折算。 */
  estimateTokens(history: AgentMessage[]): number {
    return estimateTextTokens(history.map(m => JSON.stringify(m.parts)).join(''));
  }

  /** 该模型的上下文窗口：目录（手动 > models.dev/basellm 缓存 > BUILTIN）查不到时回落 FALLBACK_WINDOW。
   *  与 decide 同一口径；压缩预算（W2a-1）与溢出降级找更大窗口（W2a-2）都用它。 */
  windowOf(modelId: string): number {
    return this.catalog.getModelContextWindow(modelId) ?? FALLBACK_WINDOW;
  }

  /** 按窗口分层决策（设计 §4.2 阈值表）。
   *  档位边界：32K/64K/128K。128K 归入「64-128K」档（语义段以范围表述，
   *  测试「128K 窗口：超 50% offload，超 70% compact」锚定此归属）。 */
  decide(modelId: string, tokenCount: number): ContextAction {
    const window = this.windowOf(modelId);
    const ratio = tokenCount / window;

    if (window > 128_000) {
      if (ratio >= 0.6) return 'compact';
      if (ratio >= 0.4) return 'offload';
      return 'none';
    }
    if (window >= 64_000) {  // 64K - 128K（含 128K）
      if (ratio >= 0.7) return 'compact';
      if (ratio >= 0.5) return 'offload';
      return 'none';
    }
    if (window >= 32_000) {
      if (ratio >= 0.7) return 'offload';
      return 'none';
    }
    // < 32K：不管（设计原文）
    return 'none';
  }
}
