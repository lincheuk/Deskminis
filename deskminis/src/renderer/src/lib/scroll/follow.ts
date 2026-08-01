/** MU2a Task 3：滚动跟随判定（决策 3，治审计 X-2，纯模块）。
 *  距底 ≤40px → 跟随（含解除后回到底部恢复）；>40px → 解除。
 *  prevFollowing 仅作签名契约保留（决策 3）：判定自足于位置——prev=false 且仍 >40 时结果恒 false，
 *  新内容到达撑高 scrollHeight 只会增大距底，天然「不抢回」。 */
export function shouldFollow(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  prevFollowing: boolean,
): boolean {
  void prevFollowing;
  return scrollHeight - scrollTop - clientHeight <= 40;
}
