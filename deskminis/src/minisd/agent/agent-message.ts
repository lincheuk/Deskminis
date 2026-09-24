import type { AgentMessage, RawMessage } from '../../shared/types';
import { sanitizeMultiline } from './sanitize';

/**
 * 一条持久化消息 → Provider 入参消息（W2a-4）。toAgentMessages（loop.ts，无压缩引擎时）与
 * buildEffectiveHistory（compact.ts）都走这里：两处各写一份映射，W2a-4 之前正是两处一起把
 * reasoningContent 丢了；以后再加字段也只改这一处。单独成模块是为了不让 compact.ts 反向 import loop.ts（循环依赖）。
 *
 * - 出口侧消毒：toolResult.output 过 sanitizeMultiline（存储不动）。
 * - reasoningContent 只在 assistant 且库里有值（!== undefined）时带上：推理只属于 assistant；
 *   条件展开而不是写 `reasoningContent: m.reasoningContent`，免得每条消息都多出一个值为 undefined 的键——
 *   既有用例拿 toEqual 比 req.messages，将来有人改成 toStrictEqual 或逐键比较就会全红。
 * 其余持久化字段（id、时间戳、tokenUsage、同步字段……）一律不带。
 */
export function toAgentMessage(m: RawMessage): AgentMessage {
  const parts = m.parts.map(p => {
    if (p.type === 'toolResult') {
      const v = p.value as { toolUseId: string; output: string; success: boolean; status: 'success' | 'failed' | 'cancelled' };
      return { type: 'toolResult' as const, value: { ...v, output: sanitizeMultiline(v.output) } };
    }
    return p;
  });
  return m.role === 'assistant' && m.reasoningContent !== undefined
    ? { role: m.role, parts, reasoningContent: m.reasoningContent }
    : { role: m.role, parts };
}
