import type { AgentMessage, CompactMarker, RawMessage } from '../../shared/types';
import type { AgentProvider } from '../providers/types';
import type { ChatStore } from '../store/chat-store';
import { sanitizeMultiline } from './sanitize';

const RECENT_USER_TURNS = 3;

/**
 * 判定一条消息是否为「真正的用户回合」（用于压缩时数最近 3 个）。
 * 本仓库 tool_result 也落库为 role='user'（M1 设计），但它不是用户提问——
 * 工具密集会话里若把它也算进去，真正的用户提问会被挤进摘要、丢失原文。
 * 判定：role==='user' 且 parts 含 text part 且不含 toolResult part。
 */
function isRealUserTurn(m: RawMessage): boolean {
  if (m.role !== 'user') return false;
  let hasText = false;
  for (const p of m.parts) {
    if (p.type === 'text') hasText = true;
    if (p.type === 'toolResult') return false;
  }
  return hasText;
}

/**
 * LLM 压缩摘要（设计 §4.2「压缩」段）。
 * 摘要存 compact_markers，推理时合成 effectiveAgentHistory，不改写存储历史。
 * 保留最近 3 个真正的用户回合原文；锚点丢失按 createdAt 自愈。
 *
 * 数据流契约（与 Task 7 一致）：
 *  - raw history 在本类里只用于「取材（toSummarize）」和「锚点定位」——永不改写。
 *  - effectiveAgentHistory 由 buildEffectiveHistory 合成，是请求构建与水位估算的唯一输入。
 */
export class CompactEngine {
  constructor(private chat: ChatStore) {}

  /**
   * 调用 provider 生成摘要并写入 compact_markers。
   * lastCompactedMessageId 锚定到「保留最近 3 个用户回合」之前的最后一条消息。
   *
   * 双轨锚定：常规路径数最近 3 个真正的用户回合；不足 3 回合时（单回合长任务如
   * 「帮我重构这个项目」永远到不了三回合门槛，旧实现直接返回 undefined = 永远无法压缩），
   * 改为按消息数锚定——只要消息足够长（≥30 条）就按「保留最近 14 条消息原文」压缩。
   * 为什么按消息数而非回合数：单回合长任务里「最近的工具轨迹」是模型继续工作的必需品，
   * 保留条数按消息算才有意义；回合数会被单个长任务稀释成 1，等于永远不压缩。
   * 消息不足 30 条仍返回 undefined——小会话没有压缩价值，且毒 marker 防御必须保留
   * （否则写个锚点=最后一条的 marker，下一轮 effectiveHistory 只剩摘要占位、整个对话被抹掉）。
   */
  async summarize(history: RawMessage[], sessionId: string, provider: AgentProvider): Promise<CompactMarker | undefined> {
    // 从后往前数 3 个「真正的用户回合」
    const userIdxs: number[] = [];
    for (let i = history.length - 1; i >= 0; i--) {
      if (isRealUserTurn(history[i])) userIdxs.push(i);
      if (userIdxs.length >= RECENT_USER_TURNS) break;
    }

    let anchorMsg: RawMessage;
    let toSummarize: RawMessage[];
    if (userIdxs.length >= RECENT_USER_TURNS) {
      // 常规路径：锚点 = 第 3 个用户回合之前的那条消息
      const anchorIdx = userIdxs[userIdxs.length - 1] - 1;
      anchorMsg = anchorIdx >= 0 ? history[anchorIdx] : history[0];
      toSummarize = anchorIdx >= 0 ? history.slice(0, anchorIdx + 1) : [];
    } else if (history.length >= 30) {
      // 双轨锚定：不足 3 回合但消息足够长 → 锚点取倒数第 15 条，保留最近 14 条原文
      const anchorIdx = history.length - 15;
      anchorMsg = history[anchorIdx];
      toSummarize = history.slice(0, anchorIdx + 1);
    } else {
      return undefined; // 不写毒 marker
    }

    // 调 provider 生成摘要（出口侧消毒：toSummarize 的 parts 过 sanitizeMultiline——送给压缩 provider 的出口侧）
    const summaryPrompt = '请用不超过 500 字总结以下对话的关键信息（用户意图、已做决策、关键文件路径、待办事项）。只输出摘要正文，不要额外格式：\n\n';
    const messages: AgentMessage[] = toSummarize.map(m => ({
      role: m.role,
      parts: m.parts.map(p => {
        if (p.type === 'toolResult') {
          const v = p.value as { toolUseId: string; output: string; success: boolean; status: 'success' | 'failed' | 'cancelled' };
          return { type: 'toolResult' as const, value: { ...v, output: sanitizeMultiline(v.output) } };
        }
        if (p.type === 'text') {
          return { type: 'text' as const, value: sanitizeMultiline(p.value as string) };
        }
        return p;
      }),
    }));
    messages.unshift({ role: 'user', parts: [{ type: 'text', value: summaryPrompt }] });

    let summary = '';
    for await (const ev of provider.streamAgentMessage({
      messages, systemPrompt: '你是对话摘要助手。',
      tools: [], maxTokens: 1024, thinkingLevel: 'off',
    })) {
      if (ev.kind === 'textDelta') summary += ev.text;
    }

    return this.chat.appendCompactMarker(sessionId, summary || '[摘要为空]', anchorMsg.id);
  }

  /**
   * 合成 effectiveAgentHistory（设计 §4.2「推理时合成」）。
   * 无 marker → 原样；有 marker → 摘要 + 锚点之后的消息；锚点丢失按 createdAt 自愈。
   * raw history 只读，永不改写。
   */
  buildEffectiveHistory(history: RawMessage[], marker: CompactMarker | undefined): AgentMessage[] {
    // 出口侧消毒：raw history 的 toolResult.output 过 sanitizeMultiline（存储不动）
    const sanitizeParts = (parts: RawMessage['parts']): AgentMessage['parts'] => parts.map(p => {
      if (p.type === 'toolResult') {
        const v = p.value as { toolUseId: string; output: string; success: boolean; status: 'success' | 'failed' | 'cancelled' };
        return { type: 'toolResult' as const, value: { ...v, output: sanitizeMultiline(v.output) } };
      }
      return p;
    });
    if (!marker) return history.map(m => ({ role: m.role, parts: sanitizeParts(m.parts) }));

    const summaryMsg: AgentMessage = {
      role: 'user',
      parts: [{ type: 'text', value: `[对话摘要] ${sanitizeMultiline(marker.summary)}` }],
    };

    // 锚点 id 存在 → 取其后所有消息
    const idx = history.findIndex(m => m.id === marker.lastCompactedMessageId);
    if (idx >= 0) {
      const after = history.slice(idx + 1).map(m => ({ role: m.role, parts: sanitizeParts(m.parts) }));
      return [summaryMsg, ...after];
    }

    // 锚点丢失：按 createdAt 自愈（设计原文）
    const selfHealIdx = history.findIndex(m => m.createdAt >= marker.createdAt);
    if (selfHealIdx >= 0) {
      const after = history.slice(selfHealIdx).map(m => ({ role: m.role, parts: sanitizeParts(m.parts) }));
      return [summaryMsg, ...after];
    }

    // 全早于 marker.createdAt：保守返回摘要 + 全部历史（不丢内容）
    return [summaryMsg, ...history.map(m => ({ role: m.role, parts: sanitizeParts(m.parts) }))];
  }
}
