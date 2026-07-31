// 消息时间格式化：epoch 秒 → 「HH:MM」（本地时区，24h，补零）。纯函数。
export function fmtHHMM(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}
