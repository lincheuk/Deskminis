/** L1 输入历史上翻（设计稿 2026-08-20-pool-batch-design.md §1）。
 *
 *  语义：输入框**为空**或**正显示某条历史**时 ↑ 取上一条、↓ 取下一条（到底清空退出）；
 *  一旦手动编辑（current ≠ entries[cursor]）即退出历史态——返回 null，调用方不拦按键，
 *  方向键回归光标移动的本职。cursor=-1 表示不在历史态。
 *  纯函数：不碰 DOM 不碰 store，方便穷举边界（空表/越界/编辑退出）。 */

export function histStep(
  entries: readonly string[],
  current: string,
  cursor: number,
  dir: -1 | 1,
): { text: string; cursor: number } | null {
  if (entries.length === 0) return null;
  const inHistory = cursor >= 0 && cursor < entries.length && current === entries[cursor];
  if (dir === -1) {
    // 上翻：空输入从最新一条进入；历史态里向更旧走，到最旧停住（不回绕——回绕会让人迷路）
    if (!inHistory) {
      if (current !== '') return null; // 有草稿不抢——草稿比历史贵
      const c = entries.length - 1;
      return { text: entries[c], cursor: c };
    }
    const c = Math.max(0, cursor - 1);
    return { text: entries[c], cursor: c };
  }
  // 下翻：仅历史态有意义；越过最新一条 = 退出历史、清空回到起点
  if (!inHistory) return null;
  const c = cursor + 1;
  if (c >= entries.length) return { text: '', cursor: -1 };
  return { text: entries[c], cursor: c };
}
