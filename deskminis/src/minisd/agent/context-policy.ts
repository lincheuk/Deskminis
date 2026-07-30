import type { AgentMessage } from '../../shared/types';

export type ContextAction = 'none' | 'offload' | 'compact';

/** 模型窗口未知时的保守回退窗口（只 offload 不 compact）。 */
const FALLBACK_WINDOW = 32_000;

/**
 * 上下文水位检查（设计 §4.2「上下文水位检查」段）。
 * 消费 M2b ModelCatalog.getModelContextWindow，按窗口分层决策。
 *
 * 注意：estimateTokens 的入参是 AgentMessage[]（不是 RawMessage[]）——
 * 水位检查在 loop.ts 里发生在 buildEffectiveHistory 之后，此时只剩 { role, parts }，
 * reasoningContent 已被丢弃，故估算只算 parts JSON 字符数 / 4。
 */
export class ContextPolicy {
  constructor(private catalog: { getModelContextWindow(modelId: string): number | undefined }) {}

  /** 粗估 token 数：parts JSON 字符数 / 4。
   *  英文 ~4 字符/token；中文偏保守（实际 2 字符/token，这里高估触发更早，安全侧）。 */
  estimateTokens(history: AgentMessage[]): number {
    let chars = 0;
    for (const m of history) chars += JSON.stringify(m.parts).length;
    return Math.ceil(chars / 4);
  }

  /** 按窗口分层决策（设计 §4.2 阈值表）。
   *  档位边界：32K/64K/128K。128K 归入「64-128K」档（语义段以范围表述，
   *  测试「128K 窗口：超 50% offload，超 70% compact」锚定此归属）。 */
  decide(modelId: string, tokenCount: number): ContextAction {
    const window = this.catalog.getModelContextWindow(modelId) ?? FALLBACK_WINDOW;
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
