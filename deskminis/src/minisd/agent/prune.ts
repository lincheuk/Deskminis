import type { AgentMessage } from '../../shared/types';

export interface PruneOptions {
  keepRecentMessages?: number;
  minChars?: number;
}

export interface PruneResult {
  pruned: number;
  history: AgentMessage[];
}

/**
 * 修剪旧的大工具结果（第一层减压，比压缩更便宜）。
 * 只在请求侧合成数组上操作：把「最近 keepRecentMessages 条之前」且 output 超过 minChars 的
 * toolResult 换成单行桩，其余 part 与消息顺序一律不动。
 *
 * 为什么不动最近 N 条：单回合长任务里「最近的工具轨迹」是模型继续工作的必需品，
 * 砍掉它会破坏 agent 的即时上下文；旧结果只剩「曾发生过什么」的参考价值，换成桩足够。
 *
 * 与 compact 的「推理时合成」同一哲学：只影响本轮请求，raw history 与存储永不改写——
 * 否则修剪成了持久化行为，模型永远拿不回原文，等于数据丢失。
 *
 * 桩只说「这次没发送、要用就重新调用工具」，不指路到 offloads（W2a-5）：能被修剪的（> minChars）
 * 要么从没超过卸载阈值、根本没落盘，要么是读回来的卸载内容；真卸载过的结果落库的是几百字的卸载桩，
 * 达不到修剪门槛。旧桩说「完整内容通常在 /var/minis/offloads/」，模型照着去找只会扑空。
 * 也不说「未落盘」：读回结果对应的文件其实还在，这句话对它不成立。
 */
export function pruneOldToolResults(history: AgentMessage[], opts?: PruneOptions): PruneResult {
  const keepRecent = opts?.keepRecentMessages ?? 12;
  const minChars = opts?.minChars ?? 2000;
  let pruned = 0;
  const out = history.map((m, i) => {
    // 最近 keepRecent 条消息（含消息本身）原样保留
    if (i >= history.length - keepRecent) return m;
    let changed = false;
    const parts = m.parts.map(p => {
      if (p.type !== 'toolResult') return p;
      const v = p.value as { toolUseId: string; output: string; success: boolean; status: 'success' | 'failed' | 'cancelled' };
      // 未超阈值不剪：小结果几乎不占 token，剪了反而丢信息
      if (v.output.length <= minChars) return p;
      changed = true;
      pruned++;
      return { type: 'toolResult' as const, value: { ...v, output: `[工具结果已修剪：原 ${v.output.length} 字符。为控制上下文长度，这条较早的结果未随本次请求发送；如仍需要，请重新调用相应工具获取]` } };
    });
    // 只换 parts、其余字段照抄：只写 {role, parts} 的话，将来被修剪的消息若带着 reasoningContent（W2a-4）
    // 就会被悄悄丢掉，DeepSeek V4 回放缺了它会 400。今天被修剪的都是 user 消息，行为不变
    return changed ? { ...m, parts } : m;
  });
  return { pruned, history: out };
}
