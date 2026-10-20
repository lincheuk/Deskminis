import type { CompactMarker, RawMessage } from '../../shared/types';

/**
 * 压缩用到的回合与锚点的基础判定（F03 从 compact.ts 挪出，compact.ts 按原名再导出，调用方不用改）。
 * 单独成模块是为了让 compact-meta.ts（取证、校验）与 compact.ts（取材、合成）共用同一套判定而不互相 import。
 */

export const RECENT_USER_TURNS = 3;

/**
 * 判定一条消息是否为「真正的用户回合」（用于压缩时数最近 3 个）。
 * 本仓库 tool_result 也落库为 role='user'（M1 设计），但它不是用户提问——
 * 工具密集会话里若把它也算进去，真正的用户提问会被挤进摘要、丢失原文。
 * 判定：role==='user' 且 parts 含 text part 且不含 toolResult part。
 * W2a-2 起导出：「上下文已满」的接力草稿要找最后一条真用户消息，与这里同一判定。
 */
export function isRealUserTurn(m: RawMessage): boolean {
  if (m.role !== 'user') return false;
  let hasText = false;
  for (const p of m.parts) {
    if (p.type === 'text') hasText = true;
    if (p.type === 'toolResult') return false;
  }
  return hasText;
}

/**
 * 用户回合（F03）：role=user、不带 toolResult、有 text 段或 mediaRef 段。比 isRealUserTurn 多认纯图片消息。
 * 只用来认定「最近的用户回合」与取用户指示；pendingSummaryRange 数最近 3 个回合仍用 isRealUserTurn——
 * 改用它会让纯图片消息顶掉一个文字回合，第 3 个回合的下标变大，锚点变晚，更早的文字指示被摘走。
 */
export function isUserTurn(m: RawMessage): boolean {
  if (m.role !== 'user') return false;
  let has = false;
  for (const p of m.parts) {
    if (p.type === 'text' || p.type === 'mediaRef') has = true;
    if (p.type === 'toolResult') return false;
  }
  return has;
}

/**
 * marker 已经摘到 history 的哪一条（下标；-1 = 一条也没摘到）。锚点之后的消息留在 effectiveHistory 原文里。
 * buildEffectiveHistory 与 summarize 共用这一条规则：前者据此决定保留哪些原文，后者据此决定增量从哪里取——
 * 两边规则一旦不同，就会有消息既不在摘要里也不在原文里（丢），或两边都在（重复摘）。
 * 锚点 id 找得到 → 就是它；找不到（对端同步删改、导入等）→ 按 createdAt 自愈：
 * 第一条不早于 marker 的消息及之后都算没摘；全早于 marker → 保守当作一条也没摘（不丢内容）。
 */
export function anchorIndexOf(history: RawMessage[], marker: CompactMarker | undefined): number {
  if (!marker) return -1;
  const idx = history.findIndex(m => m.id === marker.lastCompactedMessageId);
  if (idx >= 0) return idx;
  const heal = history.findIndex(m => m.createdAt >= marker.createdAt);
  return heal >= 0 ? heal - 1 : -1;
}

/** 旧版本（W2a-1 之前）摘要为空时写进 marker 的兜底文本；本版不再写，但库里和同步来的旧 marker 仍可能是它。 */
const LEGACY_EMPTY_SUMMARY = '[摘要为空]';

/** 这条 marker 的摘要代表不了任何内容（旧版本的空摘要兜底，或纯空白）。
 *  W2a-2 起导出：接力草稿同样不能把「[摘要为空]」当摘要交给新会话。 */
export function isUselessSummary(summary: string): boolean {
  const s = summary.trim();
  return s === '' || s === LEGACY_EMPTY_SUMMARY;
}

/**
 * 被带上的用户回合（F03 · I11）：保留回合（最近 3 个 isRealUserTurn ∪ 最近 3 个 isUserTurn）里下标 ≤ anchorIdx 的，按时间顺序。
 * 这些回合被摘要盖住了，读的时候按原话全文接在摘要消息后面（buildEffectiveHistory），不让用户的原话只剩模型转述。
 * 纯函数，只看 history，不读 meta：对本机写的、旧版本写的、同步来的 marker 都成立。常规锚点（最近 3 个真回合之前）下恒为空。
 */
export function carriedUserTurns(history: RawMessage[], anchorIdx: number): number[] {
  if (anchorIdx < 0) return [];
  const keep = new Set<number>();
  let real = 0; let any = 0;
  for (let i = history.length - 1; i >= 0 && (real < RECENT_USER_TURNS || any < RECENT_USER_TURNS); i--) {
    const m = history[i];
    if (!isUserTurn(m)) continue;
    if (any < RECENT_USER_TURNS) { any++; keep.add(i); }
    if (real < RECENT_USER_TURNS && isRealUserTurn(m)) { real++; keep.add(i); }
  }
  return [...keep].filter(i => i <= anchorIdx).sort((a, b) => a - b);
}
