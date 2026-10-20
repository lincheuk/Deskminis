import type { DiffLine } from './lcs';

export type VisibleLine = DiffLine | { type: 'fold'; start: number; count: number };
export type DiffRow = { kind: 'fold'; start: number; count: number }
  | { kind: 'unified'; line: DiffLine }
  | { kind: 'split'; old?: DiffLine; next?: DiffLine };

/** 保留两端上下文；至少省四行才值得放一条展开入口。start 指向原数组，不重算行号。 */
export function foldLines(lines: readonly DiffLine[], expanded: ReadonlySet<number>): VisibleLine[] {
  const keep = 3, minimum = 4;
  const out: VisibleLine[] = [];
  for (let i = 0; i < lines.length;) {
    if (lines[i].type !== 'ctx') { out.push(lines[i++]); continue; }
    let end = i;
    while (end < lines.length && lines[end].type === 'ctx') end++;
    const start = i + keep, count = end - i - keep * 2;
    if (count >= minimum && !expanded.has(start)) {
      out.push(...lines.slice(i, start), { type: 'fold', start, count }, ...lines.slice(end - keep, end));
    } else out.push(...lines.slice(i, end));
    i = end;
  }
  return out;
}

/** 同一网格行承载左右两格，删增在每个改动块内按序配对，多的一侧留空。 */
export function diffRows(lines: VisibleLine[], split: boolean): DiffRow[] {
  const out: DiffRow[] = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (line.type === 'fold') { out.push({ kind: 'fold', start: line.start, count: line.count }); i++; }
    else if (!split) { out.push({ kind: 'unified', line }); i++; }
    else if (line.type === 'ctx') { out.push({ kind: 'split', old: line, next: line }); i++; }
    else {
      const del: DiffLine[] = [], add: DiffLine[] = [];
      while (i < lines.length) {
        const l = lines[i];
        if (l.type === 'ctx' || l.type === 'fold') break;
        (l.type === 'del' ? del : add).push(l); i++;
      }
      for (let k = 0; k < Math.max(del.length, add.length); k++) out.push({ kind: 'split', old: del[k], next: add[k] });
    }
  }
  return out;
}

export type DiffLayout = 'unified' | 'split';
export function readDiffLayout(): DiffLayout {
  try { return localStorage.getItem('deskminis.diffLayout') === 'split' ? 'split' : 'unified'; }
  catch { return 'unified'; }
}
export function writeDiffLayout(layout: DiffLayout): void {
  try { localStorage.setItem('deskminis.diffLayout', layout); } catch { /* 本机存储不可用时仍能切换 */ }
}
