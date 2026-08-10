/** 已耗时格式化（MU5 顶部任务条）。无 DOM 依赖，node 直测——沿用 lib/time/ 既有惯例
 *  （hhmm.ts / relative.ts 都是纯函数 + 单测）。
 *
 *  口径：mm:ss，满一小时进位到 h:mm:ss。负数与非有限值一律当 0 处理——
 *  时钟回拨或 startedAt 未初始化时不该把「-1:-3」这种东西摆到常驻位上。 */
export function fmtElapsed(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
