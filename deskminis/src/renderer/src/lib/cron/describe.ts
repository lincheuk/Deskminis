/** K2 人话调度描述（设计稿 §5）：只翻译常见形态，描述不了的**直接给原表达式**——
 *  硬编出来的错人话比原文更糟（用户按人话预期，实际按表达式跑）。描述器永不抛错：
 *  它是展示层，坏表达式的拦截在后端 validateSchedule。 */

const DOW_NAMES = ['日', '一', '二', '三', '四', '五', '六'];

function two(n: number): string { return String(n).padStart(2, '0'); }

export function describeSchedule(kind: string, value: string): string {
  if (kind === 'interval') {
    const n = Number(value);
    if (!Number.isFinite(n)) return `每 ${value} 分钟`;
    return n % 60 === 0 ? `每 ${n / 60} 小时` : `每 ${n} 分钟`;
  }
  if (kind === 'once') {
    const sec = Number(value);
    if (!Number.isFinite(sec)) return `${value} 一次`;
    const d = new Date(sec * 1000);
    return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())} 一次`;
  }
  // cron：只认五段 + 简单字段形（单值/区间/步进通配），复杂形回落原文
  const f = value.trim().split(/\s+/);
  if (f.length !== 5) return `cron: ${value}`;
  const [min, hour, dom, month, dow] = f;
  const single = (s: string) => /^\d+$/.test(s) ? Number(s) : null;
  const m = single(min); const h = single(hour);
  if (dom === '*' && month === '*') {
    if (m !== null && h !== null) {
      const hm = `${two(h)}:${two(m)}`;
      if (dow === '*') return `每天 ${hm}`;
      if (dow === '1-5') return `工作日 ${hm}`;
      const d = single(dow);
      if (d !== null && d >= 0 && d <= 7) return `每周${DOW_NAMES[d === 7 ? 0 : d]} ${hm}`;
    }
    if (h === null && hour === '*' && dow === '*') {
      const step = min.match(/^\*\/(\d+)$/);
      if (step) return `每 ${step[1]} 分钟`;
      if (m !== null) return `每小时的第 ${m} 分`;
    }
  }
  return `cron: ${value}`;
}
