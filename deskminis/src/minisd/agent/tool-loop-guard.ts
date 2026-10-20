/** W2：一次运行内的失败计数；提醒只由请求组装读取，终止须等整批结果落库。 */
interface Call { name: string; input: string }
type Status = 'success' | 'failed' | 'cancelled' | 'unknown';

/** JSON 对象递归按键排序，数组保序；仅顶层 tool_title 是界面元数据。 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)]));
  }
  return value;
}

function callKey(c: Call): string {
  const { tool_title: _title, ...args } = JSON.parse(c.input) as Record<string, unknown>;
  return JSON.stringify([c.name, canonical(args)]);
}

export class ToolLoopGuard {
  private failures = new Map<string, number>();
  private warnings = new Map<string, { name: string; count: number }>();
  private unknownStreak = 0;
  stop?: string;

  beginBatch(): void { this.warnings.clear(); }

  record(c: Call, status: Status, available: boolean): void {
    this.unknownStreak = available ? 0 : this.unknownStreak + 1;
    if (this.unknownStreak >= 10) this.stop ??= '连续调用不存在的工具 10 次，已停下这一轮';
    if (status === 'cancelled' || status === 'unknown') return;
    const key = callKey(c);
    if (status === 'success') {
      this.failures.delete(key);
      this.warnings.delete(key);
      return;
    }
    const count = (this.failures.get(key) ?? 0) + 1;
    this.failures.set(key, count);
    if (count >= 3 && count < 5) this.warnings.set(key, { name: c.name, count });
    if (count >= 5) this.stop ??= `同一个工具调用（${c.name}）用相同参数连续失败 5 次，已停下这一轮`;
  }

  hints(): string[] {
    return [...this.warnings.values()].map(({ name, count }) =>
      `[系统提醒：你已经用完全相同的参数调用 ${name} 连续失败 ${count} 次。不要原样再试：换一种做法、先查清原因，或者向用户说明卡在哪里。]`);
  }
}
