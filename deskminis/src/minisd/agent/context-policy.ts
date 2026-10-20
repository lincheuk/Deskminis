import type { AgentMessage } from '../../shared/types';
import { FALLBACK_CONTEXT_WINDOW } from '../../shared/runtime-model';
import { estimateTextTokens } from '../../shared/token-estimate';

export type ContextAction = 'none' | 'offload' | 'compact';

/** 模型窗口未知时的保守回退窗口。M4.5：32K → 128K（避免落入「只 offload 不 compact」陷阱档，2026 年主流模型 ≥128K）。
 *  W2a-1 起导出：压缩预算与溢出降级都要按同一个窗口判定，各抄一份常量迟早对不上。
 *  F01R：值挪到 shared/runtime-model.ts（解析器判输出上限也要用它），这里按原名引用。 */
export const FALLBACK_WINDOW = FALLBACK_CONTEXT_WINDOW;

/** 文本 token 粗估（CJK ÷1.6、其余 ÷4）。F02：实现挪到 shared/token-estimate.ts——providers 层的请求度量也要用它，
 *  不能反向依赖 agent 层；这里按原名再导出，compact.ts 与测试的导入不变。 */
export { estimateTextTokens };

/**
 * 上下文水位检查（设计 §4.2「上下文水位检查」段）。
 * 消费 M2b ModelCatalog.getModelContextWindow，按窗口分层决策。
 *
 * 注意：estimateTokens 的入参是 AgentMessage[]（不是 RawMessage[]）——
 * 水位检查在 loop.ts 里发生在 buildEffectiveHistory 之后，估算只算 parts JSON 的字符数。
 * W2a-4 起 assistant 的 reasoningContent 也进了 AgentMessage（DeepSeek V4 要回放），但这里仍然不数它：
 * 有意保留——它只对 v4 族真的发出去，对别的模型数进去反而高估。
 * F02：带 runtime 的槽位不再用这个估算判水位——运行循环改按「实际将发送的请求」算预算（agent/request-budget.ts），
 * 系统提示、工具定义、回放推理与图片都计入；这里只剩没有 runtime 的旧调用方与预算算不出来时的回退在用。
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
    return this.decideWindow(this.windowOf(modelId), tokenCount);
  }

  /** 按给定窗口分层决策（F01）：运行循环传入当前槽位按配置实例解析出的窗口，不再按 modelId 查目录——
   *  同名模型在不同接入上的窗口与手动修正各不相同。 */
  decideWindow(window: number, tokenCount: number): ContextAction {
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
