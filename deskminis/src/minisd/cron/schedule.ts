/** K1 调度纯核心（设计稿 2026-08-20-cron-design.md §2，零依赖）。
 *
 *  三态：interval=分钟数（≥5，防自我 DDoS）/ once=epoch 秒 / cron=5 段表达式。
 *  cron 语义（按本机时区，用 Date 本地字段）：
 *    字段序 分(0-59) 时(0-23) 日(1-31) 月(1-12) 周(0-7，0 与 7 都是周日)；
 *    每字段支持 `*`、`*\/n`、`a`、`a-b`、`a-b/n`、逗号列表（项可含区间/步进）；
 *    **日/周同时受限时任一命中即触发**——Vixie cron 的经典 OR 语义，别的语义都算自造方言。
 *  next 计算用「下一整分起逐分钟扫描」：O(527k) 上界的蠢办法，但只在任务保存与跑完后
 *  各算一次——蠢而正确 > 巧而错；扫满 366 天无命中返回 null（如 2/30 这类永不到来的时刻）。 */

export type ScheduleKind = 'interval' | 'once' | 'cron';

export interface CronSpec {
  minute: Set<number>; hour: Set<number>; dom: Set<number>; month: Set<number>; dow: Set<number>;
  domWildcard: boolean; dowWildcard: boolean;
}

const FIELD_RANGES: Array<[name: string, min: number, max: number]> = [
  ['分', 0, 59], ['时', 0, 23], ['日', 1, 31], ['月', 1, 12], ['周', 0, 7],
];

function parseField(raw: string, name: string, min: number, max: number): { set: Set<number>; wildcard: boolean } {
  const set = new Set<number>();
  let wildcard = false;
  for (const part of raw.split(',')) {
    const m = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!m) throw new Error(`cron ${name}字段不合法: ${part}`);
    const step = m[2] !== undefined ? Number(m[2]) : 1;
    if (step < 1) throw new Error(`cron ${name}字段步进必须 ≥1: ${part}`);
    let lo: number; let hi: number;
    if (m[1] === '*') {
      lo = min; hi = max;
      if (step === 1) wildcard = true; // `*/n` 是受限的，只有裸 * 才算通配（dom/dow OR 语义用）
    } else if (m[1].includes('-')) {
      const [a, b] = m[1].split('-').map(Number);
      lo = a; hi = b;
      if (lo > hi) throw new Error(`cron ${name}字段区间倒置: ${part}`);
    } else {
      lo = hi = Number(m[1]);
    }
    if (lo < min || hi > max) throw new Error(`cron ${name}字段越界（${min}-${max}）: ${part}`);
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  return { set, wildcard };
}

export function parseCronExpr(expr: string): CronSpec {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron 表达式必须是 5 段（分 时 日 月 周），拿到 ${fields.length} 段`);
  const parsed = fields.map((f, i) => parseField(f, FIELD_RANGES[i][0], FIELD_RANGES[i][1], FIELD_RANGES[i][2]));
  const dow = new Set<number>([...parsed[4].set].map(v => (v === 7 ? 0 : v))); // 7 归一为 0（周日两写法）
  return {
    minute: parsed[0].set, hour: parsed[1].set, dom: parsed[2].set, month: parsed[3].set, dow,
    domWildcard: parsed[2].wildcard, dowWildcard: parsed[4].wildcard,
  };
}

export function cronMatches(spec: CronSpec, d: Date): boolean {
  if (!spec.minute.has(d.getMinutes())) return false;
  if (!spec.hour.has(d.getHours())) return false;
  if (!spec.month.has(d.getMonth() + 1)) return false;
  const domHit = spec.dom.has(d.getDate());
  const dowHit = spec.dow.has(d.getDay());
  if (spec.domWildcard && spec.dowWildcard) return true;
  if (spec.domWildcard) return dowHit;
  if (spec.dowWildcard) return domHit;
  return domHit || dowHit; // 双受限 = OR（Vixie 语义）
}

const SCAN_LIMIT_MIN = 366 * 24 * 60;

/** 下一次运行时刻（epoch ms）；null = 不再有下一次。 */
export function computeNextRun(kind: ScheduleKind, value: string, fromMs: number): number | null {
  if (kind === 'interval') {
    const n = Number(value);
    return fromMs + n * 60_000;
  }
  if (kind === 'once') {
    const sec = Number(value);
    return sec * 1000 > fromMs ? sec * 1000 : null;
  }
  const spec = parseCronExpr(value);
  // 下一整分对齐（当前这一分钟不算——「现在保存 * * * * *」应当下一分钟跑，不是立刻）
  let t = Math.floor(fromMs / 60_000) * 60_000 + 60_000;
  for (let i = 0; i < SCAN_LIMIT_MIN; i++, t += 60_000) {
    if (cronMatches(spec, new Date(t))) return t;
  }
  return null;
}

/** 入库前校验：抛中文错误（坏行不入库）。once 的「已过」只在**新建/修改**时拒——
 *  错过补跑是调度器对既有行的语义，不经这里。 */
export function validateSchedule(kind: ScheduleKind, value: string): void {
  if (kind === 'interval') {
    const n = Number(value);
    if (!Number.isFinite(n) || !Number.isInteger(n)) throw new Error('间隔必须是整数分钟数');
    if (n < 5) throw new Error('间隔最短 5 分钟——更密的轮询对模型与本机都是 DDoS');
    return;
  }
  if (kind === 'once') {
    const sec = Number(value);
    if (!Number.isFinite(sec)) throw new Error('一次性任务时间必须是 epoch 秒数');
    if (sec * 1000 <= Date.now()) throw new Error('一次性任务的时间已过去，请选将来的时刻');
    return;
  }
  if (kind === 'cron') {
    parseCronExpr(value); // 不合法自会抛
    return;
  }
  throw new Error(`未知调度类型: ${String(kind)}`);
}
