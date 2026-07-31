/** 耗时格式化（设计 v2 §2.2 mono 右置）：<60s → 「0.3s」；≥60s → 「1m02s」。
 *  epoch ms 入参，负差钳 0。纯函数。 */
export function fmtDuration(startTs: number, endTs: number): string {
  const ms = Math.max(0, endTs - startTs);
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.floor(s % 60);
  return `${m}m${String(rem).padStart(2, '0')}s`;
}
