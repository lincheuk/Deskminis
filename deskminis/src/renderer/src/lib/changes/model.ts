/**
 * F08：「改动」页与审阅面板的纯函数——分组标题、状态标签、预检与恢复结果的汇总、未覆盖调用的说明、行差分。
 * 没有组件状态、不碰 rpc：展示件按 props 调它们，测试直接断言。
 */
import type {
  FileChangeView, RestoreItemResult, RestorePrecheck, RestoreReport, RestoreVerdict, RunChangeGroup,
} from '../../../../shared/checkpoint';
import { MAX_LCS_LINES, countAddDel, diffLineArrays, splitLines, type DiffLine } from '../diff/lcs';

const MIB = 1024 * 1024;

/** 字节数的人话（检查点占用、文件大小）。 */
export function formatBytes(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '未知大小';
  if (n >= 1024 * MIB) return `${(n / (1024 * MIB)).toFixed(n % (1024 * MIB) === 0 ? 0 : 1)} GB`;
  if (n >= MIB) return `${Math.round(n / MIB)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function timeText(epochSeconds: number | undefined): string {
  if (epochSeconds === undefined) return '';
  const d = new Date(epochSeconds * 1000);
  const two = (x: number): string => String(x).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** 组头：第几次运行、什么时候、几个文件。不带账本的调用（没有 run）单独一组。
 *  按文件数（路径身份键去重）：一次运行里同一个文件改了几次都是一个文件，下面逐条列的是每一次改动。 */
export function groupTitle(g: RunChangeGroup): string {
  const n = `${new Set(g.changes.map(c => c.pathKey)).size} 个文件`;
  if (g.runId === null || g.generation === undefined) return `未归属运行的改动 · ${n}`;
  const t = timeText(g.startedAt);
  return t ? `第 ${g.generation} 次运行 · ${t} · ${n}` : `第 ${g.generation} 次运行 · ${n}`;
}

/** 一行右侧的状态。applied（可恢复的常态）不标。 */
export function stateLabel(c: Pick<FileChangeView, 'state' | 'prunedAt'>): string {
  if (c.state === 'restored') return '已恢复';
  if (c.prunedAt !== undefined) return '已清理';
  if (c.state === 'unknown') return '写入被打断';
  if (c.state === 'pending') return '核实中';
  return '';
}

/** 这次运行里副作用范围未知的调用：它们改了什么不在记录里。全为 0 时不出句子。 */
export function uncoveredNote(u: RunChangeGroup['uncovered']): string {
  const parts: string[] = [];
  if (u.shell > 0) parts.push(`${u.shell} 次 shell 命令`);
  if (u.mcp > 0) parts.push(`${u.mcp} 次 MCP 调用`);
  if (u.other > 0) parts.push(`${u.other} 次其它工具调用`);
  if (parts.length === 0) return '';
  return `这次运行还执行了 ${parts.join('、')}，它们改了什么不在记录里，也不能在这里撤销。`;
}

/** 预检汇总：哪些可以恢复、哪些不能（各带原因句）。 */
export function summarizePrecheck(items: readonly RestorePrecheck[]): { ready: RestorePrecheck[]; blocked: RestorePrecheck[] } {
  return { ready: items.filter(i => i.verdict.kind === 'ready'), blocked: items.filter(i => i.verdict.kind !== 'ready') };
}

/** 这条预检结论是不是在说「这次改动已经不在文件里」：恢复过的、当时就没有写成的。这样的记录不发，不妨碍文件回到运行之前。 */
function nothingToUndo(v: RestoreVerdict): boolean {
  return v.kind === 'unavailable' && (v.reason === 'already-restored' || v.reason === 'not-applied');
}

/**
 * 没有发的记录里，拖住「发了记录的文件」的那些：与某条要发的记录同属一个文件（fileKeys），自己的改动又还留在文件里。
 * 有这样一条，那个文件就回不到这次运行之前。按引擎的判法它只可能比发出去的那几条更早：之后的改动仍然生效、
 * 自己又不能恢复时，更早的记录都是 superseded 且链不上，这个文件一条都不发。
 */
function heldBack(notSent: readonly RestorePrecheck[], fileKeys: ReadonlySet<string>, keyOf: (i: RestorePrecheck) => string): RestorePrecheck[] {
  return notSent.filter(i => fileKeys.has(keyOf(i)) && !nothingToUndo(i.verdict));
}

/**
 * 发出去的记录里，引擎回报「这次改动已经不在文件里」的那些（同一个判据 nothingToUndo）。发什么是按预检算的，而预检会过期：
 * 预检面板开着的时候到审阅面板单独恢复了其中一条，再回来点确认，那一条照样发出去，引擎重判成「已经恢复过了」、不动文件。
 * 它与预检时就是这个结论而没有发的记录是同一回事，结果汇总里一律当成没发：不算做成、也不算没做成，归到「不需要恢复」。
 * 只数 outcome 的话，一个早就恢复好的文件会被说成「没有恢复」，整条链都回到运行之前的文件会被说成「停在中间的版本」。
 */
function sentForNothing(i: RestoreItemResult): boolean {
  return i.verdict !== undefined && nothingToUndo(i.verdict);
}

/**
 * 「恢复这次运行」发哪些记录。
 *  send：预检就绪的，加上 chained。
 *  chained：预检时是 superseded（同一文件之后还有改动）、而挡着它的那些后续改动全部在这次要发的记录里的。
 *    一次运行里同一个文件被改了好几次时（连续几次 file_edit 是常态），除最后一次外的记录都是这样：只发就绪的那一条，
 *    文件就停在一个运行前后都不存在的中间版本，要把「恢复这次运行」重复好几轮才回得去。引擎在锁内按从新到旧逐项重判，
 *    整条链一起发，一次就回到最早那次改动之前。按链传递判定：cp3 就绪 → cp2（后续是 cp3）→ cp1（后续是 cp2、cp3）。
 *  blocked：其余的。后续改动里有不在这次预检里的（更晚的运行、别的会话的记录——别的会话的发了就是整次报错）
 *    或自己不能恢复的，仍然不发。
 *  files：send 涉及几个文件。keyOf 给出一条记录属于哪个文件（清单里的路径身份键）；不给按 path。
 *  partial：这些文件里有几个回不到这次运行之前——它还有记录留在 blocked 里，而那次改动仍在文件里（heldBack）。
 *    最常见的来源是按容量清理：清理从最旧的记录起，先清到的正是链头。只发后面的几条是对的（能撤多少撤多少），
 *    但文件会停在这次运行第一次写入之后的某个版本：files 数的不是「回到运行之前的文件数」，确认之前就要说清楚。
 */
export function planRunRestore(items: readonly RestorePrecheck[], keyOf: (i: RestorePrecheck) => string = i => i.path): {
  send: RestorePrecheck[]; chained: RestorePrecheck[]; blocked: RestorePrecheck[]; files: number; partial: number;
} {
  const sending = new Set(summarizePrecheck(items).ready.map(i => i.id));
  const chainedIds = new Set<string>();
  for (let grew = true; grew;) {
    grew = false;
    for (const i of items) {
      if (sending.has(i.id) || i.verdict.kind !== 'conflict' || i.verdict.reason !== 'superseded') continue;
      const later = i.verdict.later ?? [];
      if (later.length === 0 || !later.every(l => sending.has(l.id))) continue;
      sending.add(i.id); chainedIds.add(i.id); grew = true;
    }
  }
  const send = items.filter(i => sending.has(i.id));
  const blocked = items.filter(i => !sending.has(i.id));
  const fileKeys = new Set(send.map(keyOf));
  return {
    send, chained: items.filter(i => chainedIds.has(i.id)), blocked,
    files: fileKeys.size, partial: new Set(heldBack(blocked, fileKeys, keyOf).map(keyOf)).size,
  };
}

/**
 * 恢复结果汇总。多文件恢复不是原子的：只数事实，不把部分成功说成整体成功。
 * 按文件数：一次恢复里同一个文件可以有好几条记录（同一次运行里改了多次）。它的每一条都做成了，这个文件才算恢复；
 * 只做成了后面几条的（partial）文件停在中间版本，照实说。keyOf 同 planRunRestore。
 * notSent：同一批预检里没有发的记录（planRunRestore 的 blocked）。「每一条」也包括它们：这个文件更早的一条在预检时
 * 就不能恢复（检查点已被清理、写入被打断等）而没有发，发出去的几条全做成了，文件仍然停在中间版本——只数 r.items
 * 会把它说成「已恢复」。只并进发了记录的文件（heldBack）；一条都没发的文件不进这里的数，由界面在结果下面另列
 * （splitNotSent：那里只数这里没数过的文件）。
 * 发出去而引擎回报「改动已经不在文件里」的记录（sentForNothing）当成没发：不进任何一个数；一个文件发出去的全是这种记录，
 * 它就是「一条都没发的文件」。items 是剩下的、标题数过的那些记录，界面在标题下面逐条列的就是它们；
 * 一条都不剩时（发出去的全都不需要恢复）标题照实说没有恢复任何文件，并说明原因，不写成「已恢复 0 个文件」。
 */
export function summarizeReport(
  r: RestoreReport, keyOf: (i: { id: string; path: string }) => string = i => i.path, notSent: readonly RestorePrecheck[] = [],
): {
  done: number; notDone: number; partial: number; anyDone: boolean; headline: string; items: RestoreItemResult[];
} {
  const items = r.items.filter(i => !sentForNothing(i));
  const files = new Map<string, { ok: number; bad: number }>();
  for (const i of items) {
    const f = files.get(keyOf(i)) ?? { ok: 0, bad: 0 };
    if (i.outcome === 'restored' || i.outcome === 'deleted') f.ok += 1; else f.bad += 1;
    files.set(keyOf(i), f);
  }
  for (const i of heldBack(notSent, new Set(files.keys()), keyOf)) {
    const f = files.get(keyOf(i));
    if (f) f.bad += 1;
  }
  const all = [...files.values()];
  const done = all.filter(f => f.bad === 0).length;
  const partial = all.filter(f => f.bad > 0 && f.ok > 0).length;
  const notDone = all.length - done;
  const base = all.length === 0 ? '没有恢复任何文件：这次要恢复的改动都不需要恢复。'
    : notDone === 0 ? `已恢复 ${done} 个文件。`
      : done === 0 && partial === 0 ? `没有恢复任何文件（${notDone} 个没有恢复）。`
        : `已恢复 ${done} 个文件，另有 ${notDone} 个没有恢复。`;
  const headline = partial === 0 ? base : `${base}其中 ${partial} 个只恢复了后面的几次改动，文件停在中间的版本。`;
  return { done, notDone, partial, anyDone: all.some(f => f.ok > 0), headline, items };
}

/**
 * 结果面板里「这次没有发的记录」怎么列。每个文件只在一处计数，而且只数改动还留在文件里的：
 *  notNeeded：改动已经不在文件里的记录（以前恢复过的、当时就没有写成的；与 heldBack 用同一个判据 nothingToUndo）。
 *    它们没有发，也不需要发：照样逐条列出（这次运行的每条记录都有交代），但不算「没有恢复」——先在审阅面板单独恢复了
 *    一个文件、再点「恢复这次运行」，以前会把那个早就恢复好的文件说成「另有 1 个没有恢复」。下面两堆都不含它们。
 *  sameFile：与发出去的记录同属一个文件的。这个文件已经在标题里数过（summarizeReport：已恢复，或没有恢复 / 停在中间版本），
 *    这里只逐条列出原因，不再算一个「没有恢复」的文件——以前所有没发的记录合成一句「另有 M 个没有恢复」，
 *    链头没发的文件在标题和这一句里各数了一次。
 *  otherFiles：一条都没发的文件的记录。标题不数它们，在这里按文件数另计（otherFileCount）：
 *    同一个文件的几条记录是一个文件，与标题用的是同一个单位。标题里「没有恢复」的数加上它，
 *    就是这次运行的改动还留在文件里的文件总数。
 * 发出去而引擎回报「改动已经不在文件里」的记录（sentForNothing，预检过期时才有）与 summarizeReport 同一个口径，当成没发：
 * 并进 notNeeded（排在前面，形态与预检项相同）；「发过记录的文件」不含只发了这种记录的文件——那个文件更早的一条
 * 预检时就不能恢复的，进 otherFiles 而不是 sameFile（标题没有数它，上面也没有列它）。这样上面那句「两数相加」在预检过期时仍然成立。
 * keyOf 同 planRunRestore。
 */
export function splitNotSent(
  r: RestoreReport, notSent: readonly RestorePrecheck[], keyOf: (i: { id: string; path: string }) => string = i => i.path,
): { sameFile: RestorePrecheck[]; otherFiles: RestorePrecheck[]; otherFileCount: number; notNeeded: RestorePrecheck[] } {
  const sent = new Set(r.items.filter(i => !sentForNothing(i)).map(keyOf));
  const left = notSent.filter(i => !nothingToUndo(i.verdict));
  const sameFile = left.filter(i => sent.has(keyOf(i)));
  const otherFiles = left.filter(i => !sent.has(keyOf(i)));
  const notNeeded: RestorePrecheck[] = [];
  for (const i of r.items) if (i.verdict !== undefined && nothingToUndo(i.verdict)) notNeeded.push({ id: i.id, path: i.path, verdict: i.verdict, message: i.message });
  notNeeded.push(...notSent.filter(i => nothingToUndo(i.verdict)));
  return { sameFile, otherFiles, otherFileCount: new Set(otherFiles.map(keyOf)).size, notNeeded };
}

/** 把「之后的改动」分成本会话的与别的会话的：别的会话的记录要到那个会话去恢复，这里不能一起发。 */
export function splitLater(later: readonly { id: string; sessionId: string }[] | undefined, sessionId: string): {
  here: string[]; elsewhere: { sessionId: string; count: number }[];
} {
  const here: string[] = [];
  const counts = new Map<string, number>();
  for (const l of later ?? []) {
    if (l.sessionId === sessionId) here.push(l.id);
    else counts.set(l.sessionId, (counts.get(l.sessionId) ?? 0) + 1);
  }
  return { here, elsewhere: [...counts.entries()].map(([sid, count]) => ({ sessionId: sid, count })) };
}

export type LineDiff =
  | {
    tooLarge: false; lines: DiffLine[]; add: number; del: number; oldLines: number; newLines: number;
    /** 文字相同、只有行尾符（CRLF / LF / CR）或文件末尾有没有换行不同的行数。切行时行尾被归一化了，这些差别不进 add / del：
     *  把 CRLF 文件整份写成 LF 的改动，字节全变了，增删却都是 0。 */
    eolChanged: number;
  }
  | { tooLarge: true; oldLines: number; newLines: number };

/** 每一行在原文里的行尾符（'\r\n' / '\r' / '\n'；最后一行后面没有换行时是 ''），与 splitLines 切出的行一一对应。 */
function lineEndings(s: string): string[] {
  const out: string[] = [];
  const re = /\r\n|\r|\n/g;
  let end = 0;
  for (let m = re.exec(s); m !== null; m = re.exec(s)) { out.push(m[0]); end = re.lastIndex; }
  if (end < s.length) out.push('');
  return out;
}

/**
 * 逐行比没有任何增删时，面板上写什么。有记录的改动字节一定变了：只写「增 0 行 · 删 0 行」再挂一块空差分，等于说没有差别。
 * 每一句只说判得出来的事：行尾不同要真的比出来才说；Office 比的是提取出的文字；截断时后面的内容没有比。
 */
export function noLineChangeNote(o: {
  beforeExists: boolean; rightExists: boolean; sameHash: boolean; eolChanged: number; office: boolean; truncated: boolean;
  /** 右侧比的是哪个版本（面板上「改动前 ↔ 改动后」或「改动前 ↔ 当前文件」）。缺省「改动后」。 */
  rightLabel?: '改动后' | '当前';
}): string {
  const right = o.rightLabel ?? '改动后';
  if (!o.beforeExists && !o.rightExists) return '两侧都不存在。';
  if (!o.beforeExists) return `改动前这个文件不存在，${right}是一个没有文字的文件。`;
  if (!o.rightExists) return `改动前是一个没有文字的文件，${right}这个文件不存在。`;
  if (o.sameHash) return '两侧的内容完全相同。';
  if (o.truncated) return `显示出来的部分文字相同${o.eolChanged > 0 ? '（行尾符不同）' : ''}；后面没有显示的内容没有比较。`;
  if (o.office) return '提取出的文字相同，差别在版式或文档的其它部分。';
  if (o.eolChanged > 0) return '文字相同，只有行尾符或文件末尾的换行不同。';
  return '按文本逐行比没有差别，但两侧的字节不同。';
}

/**
 * 检查点对比用的行差分。不直接调 diffLines：它任一侧超过 MAX_LCS_LINES 行就退成「旧的全删、新的全增」，
 * 而正文上限是 256 KB，普通源码文件就会碰到，面板上显示的就不是实际差分。
 *  1. 剥掉两侧相同的前缀行与后缀行（后缀不与前缀重叠），只对中间段算差分——局部修改的中间段通常只有几行；
 *  2. 中间段两侧都不超过上限 → 算差分，行号加回前缀行数，所有相同行交给 UiDiff 折叠；
 *  3. 中间段仍超限 → tooLarge（面板写明没做逐行对比，不拿整份删除加整份新增冒充差分）。
 * truncated：那一侧的正文被截断过——先丢掉被截断的最后半行，且只剥前缀（两侧的尾部不是文件真正的结尾，没有可比性）。
 */
export function lineDiff(oldText: string, newText: string, o: { oldTruncated?: boolean; newTruncated?: boolean } = {}): LineDiff {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const ea = lineEndings(oldText);
  const eb = lineEndings(newText);
  if (o.oldTruncated && a.length > 0) { a.pop(); ea.pop(); }
  if (o.newTruncated && b.length > 0) { b.pop(); eb.pop(); }
  const anyTruncated = o.oldTruncated === true || o.newTruncated === true;
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  if (!anyTruncated) {
    const max = Math.min(a.length, b.length) - p;
    while (s < max && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  }
  const midA = a.slice(p, a.length - s);
  const midB = b.slice(p, b.length - s);
  if (midA.length > MAX_LCS_LINES || midB.length > MAX_LCS_LINES) return { tooLarge: true, oldLines: a.length, newLines: b.length };
  const mid = diffLineArrays(midA, midB).map((l): DiffLine => ({
    ...l,
    ...(l.oldNo !== undefined ? { oldNo: l.oldNo + p } : {}),
    ...(l.newNo !== undefined ? { newNo: l.newNo + p } : {}),
  }));
  const { add, del } = countAddDel(mid);
  // 文字相同的行（前缀、后缀、中间段里的相同行）各比一次原文里的行尾符
  let eolChanged = 0;
  for (let i = 0; i < p; i++) if (ea[i] !== eb[i]) eolChanged += 1;
  for (let k = 1; k <= s; k++) if (ea[a.length - k] !== eb[b.length - k]) eolChanged += 1;
  for (const l of mid) if (l.type === 'ctx' && l.oldNo !== undefined && l.newNo !== undefined && ea[l.oldNo - 1] !== eb[l.newNo - 1]) eolChanged += 1;
  const lines: DiffLine[] = [];
  if (add + del > 0) {
    for (let i = 0; i < p; i++) lines.push({ type: 'ctx', text: a[i], oldNo: i + 1, newNo: i + 1 });
    lines.push(...mid);
    for (let k = 0; k < s; k++) {
      const oi = a.length - s + k; const ni = b.length - s + k;
      lines.push({ type: 'ctx', text: a[oi], oldNo: oi + 1, newNo: ni + 1 });
    }
  }
  return { tooLarge: false, lines, add, del, oldLines: a.length, newLines: b.length, eolChanged };
}
