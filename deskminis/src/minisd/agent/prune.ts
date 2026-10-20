import type { AgentMessage } from '../../shared/types';
import type { TrimLevel } from '../../shared/compaction';
import { headTailCut } from './clip';
import { defaultToolKindOf, type ToolKindOf } from './compact-meta';
import { stripInvisible } from './sanitize';

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
      const v = p.value as { toolUseId: string; output: string; success: boolean; status: 'success' | 'failed' | 'cancelled' | 'unknown' };
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

export interface TrimResult { pruned: number; clipped: number; history: AgentMessage[] }

/** 第 2 级保留的最近消息条数；第 3 级裁剪的门槛与头尾长度。 */
const TRIM = { keepRecent: 4, minChars: 2_000, clipOver: 6_000, clipHead: 3_000, clipTail: 1_000 } as const;

type ResultValue = { toolUseId: string; output: string; success: boolean; status: 'success' | 'failed' | 'cancelled' | 'unknown' };

/**
 * 请求侧裁剪的三级（F03，超窗恢复与被拒过的槽位的轮首减压用）。只改请求侧数组，保序保长；success、status、toolUseId 原样；
 * 存储永不改写。每一级都对未裁剪的有效历史做，不叠加上一级的结果，所以说明里的原长是真实原长。
 *  1：pruneOldToolResults 的缺省（最近 12 条之前、超过 2,000 字符），与 F02 的修剪逐字相同；
 *  2：保留条数收到 4；
 *  3：在 2 的结果上，把仍超过 6,000 字符的工具结果（含最近 4 条里的）换成「头 3,000 + 说明 + 尾 1,000」。
 *
 * 2、3 级的说明句按结果对应的工具分两种（kindOf，不给时用内置名单；结果对应哪个工具看紧邻的前一条 assistant 声明的调用，
 * 找不到按非只读处理）。1 级的桩只落在模型已经用过的旧结果上；2、3 级够得着最近的结果，3 级可以裁到模型还没看过的最新一条。
 * 不超过卸载阈值的 shell / MCP 结果原文就在请求里——对这种结果写「请重新调用工具」，等于提示模型把有副作用的调用再执行一遍。
 * 所以只读工具的说明才提重新调用，其余写明这次调用已经执行过、不要为了看结果重跑。
 */
export function trimForRequest(history: AgentMessage[], level: TrimLevel, kindOf: ToolKindOf = defaultToolKindOf): TrimResult {
  if (level === 1) {
    const r = pruneOldToolResults(history);
    return { pruned: r.pruned, clipped: 0, history: r.history };
  }
  let pruned = 0; let clipped = 0;
  const out = history.map((m, i) => {
    const recent = i >= history.length - TRIM.keepRecent;
    // 结果对应哪个工具：只看紧邻的前一条 assistant 声明的调用（与 pairToolResults 的归属同一口径），同一批里同 id 的按出现次序配。
    // 不建整段历史的 id → 工具名表：toolUseId 跨轮会重复（端点按响应内序号发 id，或不给 id），后声明的会盖掉先声明的——
    // shell 的结果被当成只读工具的，说明句就成了「请重新调用」。找不到声明的按非只读处理
    const prev = i > 0 && history[i - 1].role === 'assistant' ? history[i - 1] : undefined;
    const declared = prev ? prev.parts.filter(p => p.type === 'toolUse').map(p => p.value as { toolUseId: string; name: string }) : [];
    const taken = new Map<string, number>();
    const readOnly = (toolUseId: string): boolean => {
      const k = taken.get(toolUseId) ?? 0;
      taken.set(toolUseId, k + 1);
      const use = declared.filter(d => d.toolUseId === toolUseId)[k];
      return use !== undefined && kindOf(use.name) === 'read';
    };
    let changed = false;
    const parts = m.parts.map(p => {
      if (p.type !== 'toolResult') return p;
      const v = p.value as ResultValue;
      const n = v.output.length;
      // 每条结果都问一次（不管这一条裁不裁）：同批同 id 的次序才数得对
      const ro = readOnly(v.toolUseId);
      if (!recent && n > TRIM.minChars) {
        changed = true; pruned++;
        const stub = ro
          ? `[工具结果已修剪：原 ${n} 字符。为控制上下文长度，这条较早的结果未随本次请求发送；如仍需要，请重新调用相应工具获取]`
          : `[工具结果已修剪：原 ${n} 字符。为控制上下文长度，这条结果未随本次请求发送；这次调用已经执行过，不要为了查看结果重新执行它]`;
        return { type: 'toolResult' as const, value: { ...v, output: stub } };
      }
      if (level === 3 && n > TRIM.clipOver) {
        // 切点规则要看到与脱敏相同的字符（见 headTailCut）；去掉不可见字符后已经不超门槛的不动
        const s = stripInvisible(v.output);
        if (s.length <= TRIM.clipOver) return p;
        changed = true; clipped++;
        const cut = headTailCut(s, TRIM.clipHead, TRIM.clipTail);
        const note = ro
          ? `\n…[工具结果已裁剪：原 ${n} 字符，这里只保留开头与结尾；需要中间部分请重新调用工具并缩小范围]…\n`
          : `\n…[工具结果已裁剪：原 ${n} 字符，这里只保留开头与结尾；完整内容仍在会话记录里，不要为了查看省略部分重新执行这次调用]…\n`;
        return { type: 'toolResult' as const, value: { ...v, output: `${cut.head}${note}${cut.tail}` } };
      }
      return p;
    });
    // 只换 parts、其余字段照抄（理由同 pruneOldToolResults）
    return changed ? { ...m, parts } : m;
  });
  return { pruned, clipped, history: out };
}
