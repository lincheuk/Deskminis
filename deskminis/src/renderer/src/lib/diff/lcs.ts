/** 行级 diff（设计 v2 §5.4，纯前端 LCS，零后端改动）。
 *  性能闸：任一侧超 MAX_LCS_LINES 行退「整段替换」（旧全 del 新全 add，不做 O(N·M) DP）。 */
export interface DiffLine {
  type: 'ctx' | 'add' | 'del';
  text: string;
  oldNo?: number; // 旧文件 1 基行号（add 行无）
  newNo?: number; // 新文件 1 基行号（del 行无）
}

export const MAX_LCS_LINES = 2000;

function splitLines(s: string): string[] {
  const n = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (n === '') return [];
  const lines = n.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop(); // 尾换行不产生空行
  return lines;
}

export function diffLines(oldStr: string, newStr: string): DiffLine[] {
  const a = splitLines(oldStr);
  const b = splitLines(newStr);
  if (a.length > MAX_LCS_LINES || b.length > MAX_LCS_LINES) {
    return [
      ...a.map((text, i): DiffLine => ({ type: 'del', text, oldNo: i + 1 })),
      ...b.map((text, i): DiffLine => ({ type: 'add', text, newNo: i + 1 })),
    ];
  }
  // DP LCS + 回溯（规模受性能闸约束，Uint32Array 平铺省内存）
  const n = a.length;
  const m = b.length;
  const W = m + 1;
  const dp = new Uint32Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * W + j] = a[i] === b[j]
        ? dp[(i + 1) * W + j + 1] + 1
        : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ type: 'ctx', text: a[i], oldNo: i + 1, newNo: j + 1 }); i++; j++; }
    else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) { out.push({ type: 'del', text: a[i], oldNo: i + 1 }); i++; }
    else { out.push({ type: 'add', text: b[j], newNo: j + 1 }); j++; }
  }
  while (i < n) { out.push({ type: 'del', text: a[i], oldNo: i + 1 }); i++; }
  while (j < m) { out.push({ type: 'add', text: b[j], newNo: j + 1 }); j++; }
  return out;
}

export type CollapsedLine = DiffLine | { type: 'fold'; count: number };

/** 连续 ctx 段 >2*keep 时折叠中段为 { type:'fold', count }；不足不折。add/del 行原样保留。 */
export function collapseCtx(lines: DiffLine[], keep = 2): CollapsedLine[] {
  const out: CollapsedLine[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].type !== 'ctx') { out.push(lines[i]); i++; continue; }
    let j = i;
    while (j < lines.length && lines[j].type === 'ctx') j++;
    const run = lines.slice(i, j);
    if (run.length <= keep * 2) {
      out.push(...run);
    } else {
      out.push(...run.slice(0, keep));
      out.push({ type: 'fold', count: run.length - keep * 2 });
      out.push(...run.slice(run.length - keep));
    }
    i = j;
  }
  return out;
}

export function countAddDel(lines: DiffLine[]): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const l of lines) {
    if (l.type === 'add') add++;
    else if (l.type === 'del') del++;
  }
  return { add, del };
}
