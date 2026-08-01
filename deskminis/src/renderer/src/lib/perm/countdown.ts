/** 权限卡倒计时（设计 §5.2-1）：remain 秒数 ceil 取整、钳 ≥0；≤10s 变橙（urgent）。
 *  纯显示用途——超时判定权在 minisd（permission.resolved 广播 reason），renderer 不做 deadline 自判（评审命门 1）。 */

export function remainSeconds(deadlineMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000));
}

export function countdownTone(remain: number): 'normal' | 'urgent' {
  return remain <= 10 ? 'urgent' : 'normal';
}
