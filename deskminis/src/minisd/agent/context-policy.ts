import type { AgentMessage } from '../../shared/types';

export type ContextAction = 'none' | 'offload' | 'compact';

/** 模型窗口未知时的保守回退窗口。M4.5：32K → 128K（避免落入「只 offload 不 compact」陷阱档，2026 年主流模型 ≥128K）。 */
const FALLBACK_WINDOW = 128_000;

/**
 * 上下文水位检查（设计 §4.2「上下文水位检查」段）。
 * 消费 M2b ModelCatalog.getModelContextWindow，按窗口分层决策。
 *
 * 注意：estimateTokens 的入参是 AgentMessage[]（不是 RawMessage[]）——
 * 水位检查在 loop.ts 里发生在 buildEffectiveHistory 之后，此时只剩 { role, parts }，
 * reasoningContent 已被丢弃，故估算只算 parts JSON 的字符数。
 */
export class ContextPolicy {
  constructor(private catalog: { getModelContextWindow(modelId: string): number | undefined }) {}

  /** 粗估 token 数：对 parts JSON 分段估算——CJK 字符按 /1.6，其余字符按 /4。
   *  换算依据：英文约 4 字符/token，中文约 1.5–2 字符/token。
   *  旧实现整体 /4，把中文按英文密度折算，得真实值的一半（低估）→ 水位显示偏低、
   *  压缩触发过晚，中文密集的长会话会直接撞上下文上限；故 CJK 必须用更小的除数
   *  （1.6）单独折算，使其贴近真实值。CJK 范围沿用 tools/memory.ts 的 [\u4e00-\u9fa5]。 */
  estimateTokens(history: AgentMessage[]): number {
    let cjk = 0;
    let total = 0;
    for (const m of history) {
      const s = JSON.stringify(m.parts);
      total += s.length;
      // 逐字符统计 CJK（shell 与英文/数字/标点都计入 total 但不算 cjk，
      // 这样它们各自用各自密度折算，避免把 JSON 壳误当 CJK）
      cjk += (s.match(/[\u4e00-\u9fa5]/g) ?? []).length;
    }
    return Math.ceil(cjk / 1.6 + (total - cjk) / 4);
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
