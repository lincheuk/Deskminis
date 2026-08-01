/** 相对时间（MU2b Task 4，设计 §1.1-1 任务卡 meta 行）：刚刚 / N 分钟前 / HH:MM / 昨天 / M-D。
 *  epochSec 单位秒（sessions.updatedAt 同单位）；nowSec 由调用方注入（可测）。 */
export function fmtRelative(epochSec: number, nowSec: number): string {
  const diff = nowSec - epochSec;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  const d = new Date(epochSec * 1000);
  const now = new Date(nowSec * 1000);
  const dayStart = (t: Date): number => new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
  if (dayStart(d) === dayStart(now)) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  if (dayStart(d) === dayStart(now) - 86400_000) return '昨天';
  return `${d.getMonth() + 1}-${d.getDate()}`;
}
