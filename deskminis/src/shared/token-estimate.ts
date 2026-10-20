/** 文本 token 的粗估（F02 从 minisd/agent/context-policy.ts 原样搬来：providers 层的请求度量也要用它，不能反向依赖 agent 层）。 */

/** CJK 范围沿用 tools/memory.ts 的 [\u4e00-\u9fa5]。 */
const CJK = /[\u4e00-\u9fa5]/;

/** 粗估一段文本的 token 数：CJK 字符按 /1.6，其余字符按 /4，向上取整。
 *  换算依据：英文约 4 字符/token，中文约 1.5–2 字符/token。
 *  旧实现整体 /4，把中文按英文密度折算，得真实值的一半（低估）→ 水位显示偏低、
 *  压缩触发过晚，中文密集的长会话会直接撞上下文上限；故 CJK 必须用更小的除数
 *  （1.6）单独折算，使其贴近真实值。
 *  W2a-1 抽成导出函数：压缩要给「摘要请求本身」算预算，那是一段纯文本而不是 parts 数组；
 *  与水位估算共用同一公式，两边的口径才一致。字符数与 CJK 数对拼接可加，
 *  所以分段估算再相加只会比整体估算略大（每段向上取整），用来卡预算是偏保守的一侧。 */
export function estimateTextTokens(s: string): number {
  let cjk = 0;
  // 无 CJK 时保留正则的快速扫描；有 CJK 时只计数，不物化匹配数组。
  const firstCjk = s.search(CJK);
  if (firstCjk !== -1) {
    for (let i = firstCjk; i < s.length; i++) {
      const code = s.charCodeAt(i);
      if (code >= 0x4e00 && code <= 0x9fa5) cjk++;
    }
  }
  return Math.ceil(cjk / 1.6 + (s.length - cjk) / 4);
}
