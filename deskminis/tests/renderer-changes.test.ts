/**
 * F08 U 组：「改动」页与审阅面板。
 *
 * 分工按测试设施的边界定（tests/sfc-setup.ts）：
 *  - 「显示了什么」对**展示件**用 renderSfc + visibleText 断言（状态全由 props 给出，初始渲染就是那个状态；子组件是空壳）；
 *  - 「取了什么、发了什么」对**外壳**用 runSetup 断言（rpc 换可控桩）；
 *  - 差分算得对不对用 lineDiff 纯函数断言。
 * 差分行本身的 DOM（哪几行标增、哪几行标删）这里断言不了（UiDiff 是空壳），在取证脚本的真实页面上断言。
 * 载荷取 checkpoints.list / diff / inspect / restore 的真实返回形态。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/renderer/src/rpc', () => ({
  rpc: { call: vi.fn(async () => undefined), connect: async () => {}, on: vi.fn(), off: vi.fn(), onLost: vi.fn() },
}));

// eslint-disable-next-line import/first —— vi.mock 由 vitest 提升到顶部
import { join } from 'node:path';
import { effectScope, nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { rpc } from '../src/renderer/src/rpc';
import { useChat } from '../src/renderer/src/stores/chat';
import { collectArtifacts } from '../src/renderer/src/lib/artifacts/collect';
import {
  formatBytes, groupTitle, lineDiff, noLineChangeNote, planRunRestore, splitLater, splitNotSent, stateLabel, summarizePrecheck, summarizeReport, uncoveredNote,
} from '../src/renderer/src/lib/changes/model';
import { countAddDel, diffLines, splitLines } from '../src/renderer/src/lib/diff/lcs';
import {
  CHECKPOINT_SCOPE_NOTE, describeVerdict,
  type ChangeDiff, type ChangeList, type FileChangeView, type RestorePrecheck, type RestoreReport, type RestoreVerdict,
} from '../src/shared/checkpoint';
import { readFileSync } from 'node:fs';
import { sfcBlocks } from './sfc-blocks';
import { renderSfc, runSetup, visibleText } from './sfc-setup';

const UI = join(__dirname, '..', 'src', 'renderer', 'src', 'ui');
const LIST_VIEW = join(UI, 'ChangeListView.vue');
const REVIEW_VIEW = join(UI, 'ChangeReviewView.vue');
const LIST = join(UI, 'ChangeList.vue');
const REVIEW = join(UI, 'ChangeReview.vue');
const APP = join(UI, 'AppShell.vue');
const call = rpc.call as unknown as ReturnType<typeof vi.fn>;
const on = rpc.on as unknown as ReturnType<typeof vi.fn>;
const off = rpc.off as unknown as ReturnType<typeof vi.fn>;
const flush = async (): Promise<void> => { for (let i = 0; i < 6; i++) { await Promise.resolve(); await nextTick(); } };

const change = (o: Partial<FileChangeView> & { id: string; displayPath: string }): FileChangeView => ({
  seq: 1, sessionId: 'S1', runId: 'RUN-1', executionId: 'E1', toolUseId: `tu-${o.id}`, toolName: 'file_edit', ordinal: 0,
  path: `C:\\work\\${o.displayPath}`, pathKey: `c:\\work/${o.displayPath.toLowerCase()}`, kind: 'modify', state: 'applied',
  before: { exists: true, hash: 'a'.repeat(64), size: 10 }, after: { exists: true, hash: 'b'.repeat(64), size: 12 },
  beforeStored: true, afterStored: false, createdAt: 1_790_000_000, appliedAt: 1_790_000_001, ...o,
});
const usage = { usedBytes: 152 * 1024 * 1024, blobCount: 4, checkpointCount: 5, quotaBytes: 1024 * 1024 * 1024, retentionDays: 30, maxFileBytes: 64 * 1024 * 1024, protectedBytes: 0, overQuota: false };
const twoRuns = (): ChangeList => ({
  groups: [
    { runId: 'RUN-2', generation: 2, startedAt: 1_790_000_600, runState: 'completed', changes: [change({ id: 'c3', displayPath: 'notes/second.md', seq: 3 })], uncovered: { shell: 0, mcp: 0, other: 0 } },
    {
      runId: 'RUN-1', generation: 1, startedAt: 1_790_000_000, runState: 'completed',
      changes: [change({ id: 'c2', displayPath: 'report.docx', seq: 2, kind: 'create', toolName: 'office_write' }), change({ id: 'c1', displayPath: 'src/main.ts', seq: 1 })],
      uncovered: { shell: 1, mcp: 0, other: 0 },
    },
  ],
  coveredToolUseIds: ['tu-c1', 'tu-c2', 'tu-c3'], truncated: false, usage,
});
const listProps = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
  list: twoRuns(), legacy: [], error: '', expandedRunId: null, precheck: null, report: null, busy: false, quotaEditing: false, quotaError: '', ...o,
});
const textDiff = (o: Partial<ChangeDiff> = {}): ChangeDiff => ({
  change: change({ id: 'c1', displayPath: 'src/main.ts' }),
  before: { exists: true, size: 12, hash: 'a'.repeat(64), source: 'blob', form: 'text', text: 'one\ntwo\nthree\n' },
  after: { exists: true, size: 12, hash: 'b'.repeat(64), source: 'file', form: 'text', text: 'one\nTWO\nthree\n' },
  current: { exists: true, size: 12, hash: 'b'.repeat(64), source: 'file', form: 'text', text: 'one\nTWO\nthree\n' },
  currentIs: 'after', ...o,
});
const READY: RestoreVerdict = { kind: 'ready', action: 'overwrite' };
const reviewProps = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
  diff: textDiff(), verdict: READY, message: describeVerdict(READY), laterHere: [], laterElsewhere: [], sessionTitles: {},
  confirming: null, result: null, saved: '', busy: false, error: '', ...o,
});
/** 某个按钮在 HTML 里带不带 disabled。 */
const buttonDisabled = (html: string, label: string): boolean => {
  const m = [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].find(x => x[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() === label);
  if (!m) throw new Error(`没有找到按钮「${label}」`);
  return /\sdisabled(?=[\s=>]|$)/.test(m[1]);
};

beforeEach(() => {
  setActivePinia(createPinia());
  call.mockReset(); on.mockReset(); off.mockReset();
  call.mockImplementation(async () => undefined);
});

describe('F08 U 组：纯函数', () => {
  it('分组标题、状态标签、未覆盖调用的句子（0 次不出句子）、字节格式', () => {
    const g = twoRuns().groups[1];
    expect(groupTitle(g)).toMatch(/^第 1 次运行 · .+ · 2 个文件$/);
    expect(groupTitle({ runId: null, changes: g.changes, uncovered: g.uncovered })).toBe('未归属运行的改动 · 2 个文件');
    // 同一个文件在这次运行里改了两次：三条记录、两个文件
    expect(groupTitle({ ...g, changes: [change({ id: 'c4', displayPath: 'src/main.ts', seq: 4 }), ...g.changes] })).toMatch(/^第 1 次运行 · .+ · 2 个文件$/);
    expect(stateLabel({ state: 'applied' })).toBe('');
    expect(stateLabel({ state: 'restored' })).toBe('已恢复');
    expect(stateLabel({ state: 'applied', prunedAt: 1 })).toBe('已清理');
    expect(stateLabel({ state: 'unknown' })).toBe('写入被打断');
    expect(uncoveredNote({ shell: 0, mcp: 0, other: 0 })).toBe('');
    expect(uncoveredNote({ shell: 2, mcp: 1, other: 0 })).toBe('这次运行还执行了 2 次 shell 命令、1 次 MCP 调用，它们改了什么不在记录里，也不能在这里撤销。');
    expect(uncoveredNote({ shell: 1, mcp: 0, other: 0 })).not.toContain('MCP');
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1 GB');
    expect(formatBytes(152 * 1024 * 1024)).toBe('152 MB');
    expect(formatBytes(2048)).toBe('2.0 KB');
  });

  it('预检与结果汇总、splitLater', () => {
    const pre: RestorePrecheck[] = [
      { id: 'a', path: 'a', verdict: READY, message: 'x' },
      { id: 'b', path: 'b', verdict: { kind: 'conflict', reason: 'modified' }, message: 'y' },
      { id: 'c', path: 'c', verdict: { kind: 'ready', action: 'delete' }, message: 'z' },
    ];
    expect(summarizePrecheck(pre).ready.map(p => p.id)).toEqual(['a', 'c']);
    expect(summarizePrecheck(pre).blocked.map(p => p.id)).toEqual(['b']);
    const rep: RestoreReport = { allRestored: false, items: [{ id: 'a', path: 'a', outcome: 'restored', message: '' }, { id: 'b', path: 'b', outcome: 'conflict', message: '' }, { id: 'c', path: 'c', outcome: 'deleted', message: '' }] };
    expect(summarizeReport(rep)).toMatchObject({ done: 2, notDone: 1, anyDone: true, headline: '已恢复 2 个文件，另有 1 个没有恢复。' });
    expect(summarizeReport({ allRestored: false, items: [rep.items[1]] })).toMatchObject({ done: 0, anyDone: false });
    expect(splitLater([{ id: 'x', sessionId: 'S1' }, { id: 'y', sessionId: 'S2' }, { id: 'z', sessionId: 'S2' }], 'S1'))
      .toEqual({ here: ['x'], elsewhere: [{ sessionId: 'S2', count: 2 }] });
    expect(splitLater(undefined, 'S1')).toEqual({ here: [], elsewhere: [] });
  });

  it('planRunRestore：同一文件在一次运行里改了三次——就绪的只有最后一次，前两次（superseded，后续都在这次要发的里）按链一起发；文件数按文件算', () => {
    const sup = (id: string, later: string[], sessionId = 'S1'): RestorePrecheck => {
      const verdict: RestoreVerdict = { kind: 'conflict', reason: 'superseded', later: later.map(l => ({ id: l, sessionId })) };
      return { id, path: 'C:\\work\\a.txt', verdict, message: describeVerdict(verdict, 'S1') };
    };
    // 清单的顺序：从新到旧
    const pre: RestorePrecheck[] = [
      { id: 'b1', path: 'C:\\work\\b.txt', verdict: READY, message: 'r' },
      { id: 'a3', path: 'C:\\work\\a.txt', verdict: READY, message: 'r' },
      sup('a2', ['a3']),
      sup('a1', ['a2', 'a3']),
    ];
    const plan = planRunRestore(pre);
    expect(plan.send.map(i => i.id)).toEqual(['b1', 'a3', 'a2', 'a1']);     // 整条链都发：引擎锁内从新到旧逐项重判
    expect(plan.chained.map(i => i.id)).toEqual(['a2', 'a1']);
    expect(plan.blocked).toEqual([]);
    expect(plan.files).toBe(2);                                            // 四条记录、两个文件
    // 顺序倒过来（旧的在前）也一样：按链传递，不依赖遍历顺序
    expect(planRunRestore([...pre].reverse()).send.map(i => i.id).sort()).toEqual(['a1', 'a2', 'a3', 'b1']);
    // 文件的身份由 keyOf 给（预检里的路径可能只差大小写）
    expect(planRunRestore(pre, () => 'same').files).toBe(1);
  });

  it('planRunRestore：链上最新的一次自己不能恢复、后续改动不在这次预检里（更晚的运行或别的会话）、没带 later 的 superseded——都不发', () => {
    const modified: RestoreVerdict = { kind: 'conflict', reason: 'modified' };
    const sup = (id: string, later: { id: string; sessionId: string }[] | undefined): RestorePrecheck =>
      ({ id, path: `p-${id}`, verdict: { kind: 'conflict', reason: 'superseded', ...(later ? { later } : {}) }, message: 'm' });
    // 最新的一次被用户改过：整条链都不能动
    const broken = planRunRestore([
      { id: 'a3', path: 'a', verdict: modified, message: 'm' },
      sup('a2', [{ id: 'a3', sessionId: 'S1' }]),
      sup('a1', [{ id: 'a2', sessionId: 'S1' }, { id: 'a3', sessionId: 'S1' }]),
    ]);
    expect(broken.send).toEqual([]);
    expect(broken.blocked.map(i => i.id)).toEqual(['a3', 'a2', 'a1']);
    expect(broken.files).toBe(0);
    // 后续改动在更晚的运行里（本会话，但不在这次预检的记录里）、在别的会话里：都不发（别的会话的发了就是整次报错）
    const outside = planRunRestore([
      { id: 'r1', path: 'r', verdict: READY, message: 'r' },
      sup('x1', [{ id: 'later-run', sessionId: 'S1' }]),
      sup('y1', [{ id: 'r1', sessionId: 'S1' }, { id: 'other-session', sessionId: 'S2' }]),
      sup('z1', undefined),
      sup('w1', []),
    ]);
    expect(outside.send.map(i => i.id)).toEqual(['r1']);
    expect(outside.chained).toEqual([]);
    expect(outside.blocked.map(i => i.id)).toEqual(['x1', 'y1', 'z1', 'w1']);
    // 已恢复过的一条挡不住更早的就绪项，自己也不发
    const done = planRunRestore([
      { id: 'a2', path: 'a', verdict: { kind: 'unavailable', reason: 'already-restored' }, message: 'm' },
      { id: 'a1', path: 'a', verdict: READY, message: 'r' },
    ]);
    expect(done.send.map(i => i.id)).toEqual(['a1']);
    expect(done.blocked.map(i => i.id)).toEqual(['a2']);
  });

  it('summarizeReport 按文件数：同一个文件的几条都做成了才算恢复；只做成后面几条的照实说停在中间版本', () => {
    const item = (id: string, path: string, outcome: RestoreReport['items'][number]['outcome']): RestoreReport['items'][number] => ({ id, path, outcome, message: '' });
    const chain: RestoreReport = { allRestored: true, items: [item('a1', 'a', 'restored'), item('a2', 'a', 'restored'), item('a3', 'a', 'restored'), item('b1', 'b', 'deleted')] };
    expect(summarizeReport(chain)).toMatchObject({ done: 2, notDone: 0, partial: 0, anyDone: true, headline: '已恢复 2 个文件。' });
    const half: RestoreReport = { allRestored: false, items: [item('a1', 'a', 'failed'), item('a2', 'a', 'restored'), item('b1', 'b', 'restored')] };
    const s = summarizeReport(half);
    expect(s).toMatchObject({ done: 1, notDone: 1, partial: 1, anyDone: true });
    expect(s.headline).toBe('已恢复 1 个文件，另有 1 个没有恢复。其中 1 个只恢复了后面的几次改动，文件停在中间的版本。');
    // 只有那一个停在中间的文件：不说「没有恢复任何文件」（它的内容确实变了），也照样提示告诉模型
    const only = summarizeReport({ allRestored: false, items: [item('a1', 'a', 'failed'), item('a2', 'a', 'restored')] });
    expect(only).toMatchObject({ done: 0, notDone: 1, partial: 1, anyDone: true });
    expect(only.headline).not.toContain('没有恢复任何文件');
    expect(only.headline).toContain('停在中间的版本');
    expect(summarizeReport({ allRestored: false, items: [item('a1', 'a', 'conflict')] }).headline).toBe('没有恢复任何文件（1 个没有恢复）。');
    // 文件的身份由 keyOf 给
    expect(summarizeReport(chain, i => i.id).done).toBe(4);
  });

  it('链头在预检时就不能恢复（检查点已被清理）、后面两条可恢复：planRunRestore 只发后两条并标出这个文件回不到运行之前；summarizeReport 带上没发的记录后算「停在中间版本」，不算已恢复', () => {
    const A = 'C:\\work\\a.txt';
    const un = (id: string, reason: Extract<RestoreVerdict, { kind: 'unavailable' }>['reason'], path = A): RestorePrecheck => {
      const verdict: RestoreVerdict = { kind: 'unavailable', reason };
      return { id, path, verdict, message: describeVerdict(verdict) };
    };
    const sup = (id: string, later: string[]): RestorePrecheck => {
      const verdict: RestoreVerdict = { kind: 'conflict', reason: 'superseded', later: later.map(l => ({ id: l, sessionId: 'S1' })) };
      return { id, path: A, verdict, message: describeVerdict(verdict, 'S1') };
    };
    const ready = (id: string, path = A): RestorePrecheck => ({ id, path, verdict: READY, message: 'r' });
    const allOk = (items: readonly RestorePrecheck[]): RestoreReport =>
      ({ allRestored: true, items: items.map(i => ({ id: i.id, path: i.path, outcome: 'restored' as const, message: '' })) });

    // 清单的顺序：从新到旧。a1 是这次运行对 a.txt 的第一次改动，它的检查点已按容量清理（清理从最旧的记录起）
    const plan = planRunRestore([ready('a3'), sup('a2', ['a3']), un('a1', 'pruned')]);
    expect(plan.send.map(i => i.id)).toEqual(['a3', 'a2']);                // 能撤多少撤多少：后两条照发
    expect(plan.blocked.map(i => i.id)).toEqual(['a1']);
    expect([plan.files, plan.partial]).toEqual([1, 1]);                     // 会动到 1 个文件，而它回不到这次运行之前
    // 引擎对发出去的两条都报 restored。对照：不交没发的记录时只数得到 r.items，会把这个文件说成已恢复
    expect(summarizeReport(allOk(plan.send)).headline).toBe('已恢复 1 个文件。');
    const s = summarizeReport(allOk(plan.send), undefined, plan.blocked);
    expect(s).toMatchObject({ done: 0, notDone: 1, partial: 1, anyDone: true });
    expect(s.headline).toBe('已恢复 0 个文件，另有 1 个没有恢复。其中 1 个只恢复了后面的几次改动，文件停在中间的版本。');

    // 另一个文件整条链都恢复了：它照常算已恢复，停在中间的只有 a.txt
    const B = 'C:\\work\\b.txt';
    const two = planRunRestore([ready('b1', B), ready('a3'), sup('a2', ['a3']), un('a1', 'pruned')]);
    expect([two.files, two.partial]).toEqual([2, 1]);
    expect(summarizeReport(allOk(two.send), undefined, two.blocked).headline)
      .toBe('已恢复 1 个文件，另有 1 个没有恢复。其中 1 个只恢复了后面的几次改动，文件停在中间的版本。');

    // 改动仍留在文件里的每一种「没发」都算：写入被打断、状态没核实完、后续改动里有这次发不了的（别的会话在中间改过）
    for (const blockedHead of [un('a1', 'unknown-state'), un('a1', 'unsettled'), sup('a1', ['other-session', 'a2'])]) {
      const p = planRunRestore([ready('a2'), blockedHead]);
      expect([p.send.map(i => i.id), p.partial], blockedHead.message).toEqual([['a2'], 1]);
      expect(summarizeReport(allOk(p.send), undefined, p.blocked).partial, blockedHead.message).toBe(1);
    }
    // 改动已经不在文件里的不算：恢复过的、当时就没写成的——不发它们，文件照样回到这次运行之前
    for (const harmless of [un('a2', 'already-restored'), un('a2', 'not-applied')]) {
      const p = planRunRestore([harmless, ready('a1')]);
      expect([p.send.map(i => i.id), p.blocked.map(i => i.id), p.partial], harmless.message).toEqual([['a1'], ['a2'], 0]);
      expect(summarizeReport(allOk(p.send), undefined, p.blocked), harmless.message).toMatchObject({ done: 1, partial: 0, headline: '已恢复 1 个文件。' });
    }
    // 没发的记录属于别的文件（那个文件一条都没发）：不并进标题的数，由界面在结果下面另列
    const other = planRunRestore([ready('a1'), un('b1', 'pruned', B)]);
    expect([other.files, other.partial]).toEqual([1, 0]);
    expect(summarizeReport(allOk(other.send), undefined, other.blocked)).toMatchObject({ done: 1, notDone: 0, partial: 0, headline: '已恢复 1 个文件。' });
    // 文件的身份由 keyOf 给：预检里的路径只差大小写时，按路径是两个文件，按身份键是同一个
    const cased = [ready('a2', 'C:\\work\\A.txt'), un('a1', 'pruned')];
    expect(planRunRestore(cased).partial).toBe(0);
    const sameFile = (): string => 'c:\\work/a.txt';
    const byKey = planRunRestore(cased, sameFile);
    expect(byKey.partial).toBe(1);
    expect(summarizeReport(allOk(byKey.send), sameFile, byKey.blocked).partial).toBe(1);
    // 发出去的那几条自己就失败了（文件一个字节没动）：不因为没发的记录变成「停在中间版本」
    const failed: RestoreReport = { allRestored: false, items: [{ id: 'a3', path: A, outcome: 'conflict', message: '' }, { id: 'a2', path: A, outcome: 'conflict', message: '' }] };
    expect(summarizeReport(failed, undefined, plan.blocked)).toMatchObject({ done: 0, notDone: 1, partial: 0, anyDone: false, headline: '没有恢复任何文件（1 个没有恢复）。' });
  });

  it('splitNotSent（R2-1）：没发的记录按「它的文件这次发没发过记录」分两堆——发过的已经在标题里数过，只逐条列；一条都没发的文件另按文件数计', () => {
    const A = 'C:\\work\\a.txt'; const B = 'C:\\work\\b.txt'; const C = 'C:\\work\\c.txt';
    const blocked = (id: string, path: string, reason: Extract<RestoreVerdict, { kind: 'unavailable' }>['reason'] = 'pruned'): RestorePrecheck => {
      const verdict: RestoreVerdict = { kind: 'unavailable', reason };
      return { id, path, verdict, message: describeVerdict(verdict) };
    };
    const report: RestoreReport = { allRestored: true, items: [{ id: 'a3', path: A, outcome: 'restored', message: '' }, { id: 'a2', path: A, outcome: 'restored', message: '' }] };
    // a1 与发出去的 a3、a2 同属 a.txt；b.txt 有两条、c.txt 有一条，这两个文件一条都没发
    const notSent = [blocked('a1', A), blocked('b2', B), blocked('b1', B, 'unknown-state'), blocked('c1', C)];
    const s = splitNotSent(report, notSent);
    expect(s.sameFile.map(i => i.id)).toEqual(['a1']);
    expect(s.otherFiles.map(i => i.id)).toEqual(['b2', 'b1', 'c1']);
    expect(s.otherFileCount).toBe(2);                              // 三条记录、两个文件
    // 与标题合起来每个文件恰好数一次：标题数发过记录的文件（a.txt），这里数其余的（b.txt、c.txt）
    const head = summarizeReport(report, undefined, notSent);
    expect(head.done + head.notDone + s.otherFileCount).toBe(3);
    // 改动已经不在文件里的记录（恢复过的）：两堆都不进、不算一个「没有恢复」的文件，另归一堆（见下一条用例）
    const a0 = blocked('a0', A, 'already-restored');
    expect(splitNotSent(report, [a0])).toEqual({ sameFile: [], otherFiles: [], otherFileCount: 0, notNeeded: [a0] });
    // 文件的身份由 keyOf 给：预检里的路径只差大小写时按身份键是同一个文件
    const cased = [blocked('a1', 'C:\\work\\A.TXT')];
    expect(splitNotSent(report, cased).otherFileCount).toBe(1);
    expect(splitNotSent(report, cased, () => 'c:\\work/a.txt')).toMatchObject({ otherFiles: [], otherFileCount: 0 });
    expect(splitNotSent(report, [])).toEqual({ sameFile: [], otherFiles: [], otherFileCount: 0, notNeeded: [] });
  });

  it('splitNotSent：改动已经不在文件里的记录（以前恢复过的、当时就没有写成的）不算「没有恢复」——不进 sameFile / otherFiles、不计入 otherFileCount，单独归到 notNeeded；它的文件这次发没发过记录都一样', () => {
    const A = 'C:\\work\\a.txt'; const X = 'C:\\work\\x.txt'; const Y = 'C:\\work\\y.txt'; const Z = 'C:\\work\\z.txt';
    const blocked = (id: string, path: string, reason: Extract<RestoreVerdict, { kind: 'unavailable' }>['reason']): RestorePrecheck => {
      const verdict: RestoreVerdict = { kind: 'unavailable', reason };
      return { id, path, verdict, message: describeVerdict(verdict) };
    };
    const report: RestoreReport = { allRestored: true, items: [{ id: 'a2', path: A, outcome: 'restored', message: '' }] };
    // 先在审阅面板单独恢复了 x.txt 的那次改动，再对同一次运行点「恢复这次运行」：x1 预检是「已经恢复过了」，没有发
    const x1 = blocked('x1', X, 'already-restored');
    const one = splitNotSent(report, [x1]);
    expect(one).toEqual({ sameFile: [], otherFiles: [], otherFileCount: 0, notNeeded: [x1] });
    // 标题加这里：没有恢复的文件是 0 个（x.txt 早就恢复好了），不是 1 个
    const head = summarizeReport(report, undefined, [x1]);
    expect([head.done, head.notDone, one.otherFileCount]).toEqual([1, 0, 0]);
    // 同一个文件里更早的一条恢复过（a1）、当时没写成的（y1）、真的没恢复的（z2 已清理；同一个文件的 z1 恢复过）混在一起
    const a1 = blocked('a1', A, 'already-restored'); const y1 = blocked('y1', Y, 'not-applied');
    const z2 = blocked('z2', Z, 'pruned'); const z1 = blocked('z1', Z, 'already-restored');
    const mixed = splitNotSent(report, [z2, z1, y1, x1, a1]);
    expect(mixed.sameFile).toEqual([]);
    expect(mixed.otherFiles).toEqual([z2]);
    expect(mixed.otherFileCount).toBe(1);
    expect(mixed.notNeeded).toEqual([z1, y1, x1, a1]);
    // 其余「不能恢复」的原因都还算没有恢复
    for (const reason of ['pruned', 'unknown-state', 'unsettled', 'blob-missing', 'blob-corrupt', 'run-active', 'rule-blocked', 'session-deleted'] as const) {
      expect(splitNotSent(report, [blocked('x1', X, reason)]), reason).toMatchObject({ otherFileCount: 1, notNeeded: [] });
    }
  });

  it('过期预检：发出去的记录被引擎回报成「已经恢复过」/「当时没有写成」（预检之后、确认之前在审阅面板单独恢复了它）——这样的项当成没发：summarizeReport 不把它的文件数成「没有恢复」，也不把整条链说成停在中间版本；splitNotSent 把它并进 notNeeded，只有这种项的文件不算「发过记录的文件」；别的结论照旧算没有恢复', () => {
    const A = 'C:\\work\\a.txt'; const C = 'C:\\work\\c.txt';
    const un = (reason: Extract<RestoreVerdict, { kind: 'unavailable' }>['reason']): RestoreVerdict => ({ kind: 'unavailable', reason });
    // 引擎对「发出去、但改动已经不在文件里」的记录给的形态：outcome 是 unavailable，带预检结论（restore.ts itemOf）
    const sentAs = (id: string, path: string, reason: Extract<RestoreVerdict, { kind: 'unavailable' }>['reason']): RestoreReport['items'][number] =>
      ({ id, path, outcome: 'unavailable', verdict: un(reason), message: describeVerdict(un(reason)) });
    const ok = (id: string, path: string): RestoreReport['items'][number] => ({ id, path, outcome: 'restored', message: '' });
    const blocked = (id: string, path: string, reason: Extract<RestoreVerdict, { kind: 'unavailable' }>['reason']): RestorePrecheck =>
      ({ id, path, verdict: un(reason), message: describeVerdict(un(reason)) });

    // 一、a.txt 恢复成功；c.txt 预检时就绪、确认之前已单独恢复——以前是「已恢复 1 个文件，另有 1 个没有恢复。」
    for (const reason of ['already-restored', 'not-applied'] as const) {
      const rep: RestoreReport = { allRestored: false, items: [ok('a1', A), sentAs('c1', C, reason)] };
      const head = summarizeReport(rep);
      expect(head, reason).toMatchObject({ done: 1, notDone: 0, partial: 0, anyDone: true, headline: '已恢复 1 个文件。' });
      // 标题下面逐条列的只有标题数过的那些记录
      expect(head.items.map(i => i.id), reason).toEqual(['a1']);
      const rest = splitNotSent(rep, []);
      expect(rest, reason).toEqual({
        sameFile: [], otherFiles: [], otherFileCount: 0,
        notNeeded: [{ id: 'c1', path: C, verdict: un(reason), message: describeVerdict(un(reason)) }],
      });
    }

    // 二、只发了 c.txt 这一条，而它已经恢复过——以前是「没有恢复任何文件（1 个没有恢复）。」
    const only: RestoreReport = { allRestored: false, items: [sentAs('c1', C, 'already-restored')] };
    const none = summarizeReport(only);
    expect(none).toMatchObject({ done: 0, notDone: 0, partial: 0, anyDone: false, headline: '没有恢复任何文件：这次要恢复的改动都不需要恢复。' });
    expect(none.items).toEqual([]);
    expect(none.headline).not.toContain('个没有恢复');
    expect(splitNotSent(only, []).notNeeded.map(i => i.id)).toEqual(['c1']);

    // 三、同一个文件的整条链都发了，最新的一条先单独恢复过：后两条恢复成功，文件回到这次运行之前——
    // 以前 a3 算一条「没做成」，标题是「已恢复 0 个文件，另有 1 个没有恢复。其中 1 个只恢复了后面的几次改动，文件停在中间的版本。」
    const chain: RestoreReport = { allRestored: false, items: [sentAs('a3', A, 'already-restored'), ok('a2', A), ok('a1', A)] };
    const whole = summarizeReport(chain);
    expect(whole).toMatchObject({ done: 1, notDone: 0, partial: 0, anyDone: true, headline: '已恢复 1 个文件。' });
    expect(whole.items.map(i => i.id)).toEqual(['a2', 'a1']);
    expect(splitNotSent(chain, []).notNeeded.map(i => i.id)).toEqual(['a3']);

    // 四、c.txt 发出去的那条（c2）已经恢复过，它更早的一条（c1）预检时就不能恢复、没有发：c1 的改动还留在文件里。
    // c.txt 这次等于一条都没发——标题不数它，c1 进「另有 N 个没有恢复」（不进「上面的文件里」：上面没有列它），整个面板里只数一次
    const mixed: RestoreReport = { allRestored: false, items: [ok('a1', A), sentAs('c2', C, 'already-restored')] };
    const c1 = blocked('c1', C, 'pruned');
    const x1 = blocked('x1', 'C:\\work\\x.txt', 'already-restored');
    const head4 = summarizeReport(mixed, undefined, [c1, x1]);
    expect(head4).toMatchObject({ done: 1, notDone: 0, partial: 0, headline: '已恢复 1 个文件。' });
    const rest4 = splitNotSent(mixed, [c1, x1]);
    expect(rest4.sameFile).toEqual([]);
    expect(rest4.otherFiles).toEqual([c1]);
    expect(rest4.otherFileCount).toBe(1);
    // 发出去才发现不需要恢复的排在前，预检时就知道的排在后
    expect(rest4.notNeeded.map(i => i.id)).toEqual(['c2', 'x1']);
    // 要数的两个文件各数一次：a.txt 已恢复、c.txt 另有 1 个没有恢复；x.txt 不需要恢复，不在这三个数里
    expect(head4.done + head4.notDone + rest4.otherFileCount).toBe(2);

    // 五、发出去的这种项与同一个文件里真的没做成的一条并存：文件照旧算没有恢复，这一项仍然只进 notNeeded
    const bad: RestoreReport = { allRestored: false, items: [sentAs('a2', A, 'already-restored'), { id: 'a1', path: A, outcome: 'conflict', verdict: { kind: 'conflict', reason: 'modified' }, message: '' }] };
    expect(summarizeReport(bad)).toMatchObject({ done: 0, notDone: 1, partial: 0, anyDone: false, headline: '没有恢复任何文件（1 个没有恢复）。' });
    expect(splitNotSent(bad, [blocked('a0', A, 'pruned')])).toMatchObject({ sameFile: [{ id: 'a0' }], otherFiles: [], otherFileCount: 0, notNeeded: [{ id: 'a2' }] });

    // 六、其余「不能恢复」的结论发出去之后照旧算没有恢复（改动还留在文件里），不进 notNeeded；没带结论的失败项同理
    for (const reason of ['pruned', 'unknown-state', 'unsettled', 'blob-missing', 'blob-corrupt', 'run-active', 'rule-blocked', 'session-deleted'] as const) {
      const rep: RestoreReport = { allRestored: false, items: [sentAs('c1', C, reason)] };
      expect(summarizeReport(rep), reason).toMatchObject({ done: 0, notDone: 1, headline: '没有恢复任何文件（1 个没有恢复）。' });
      expect(summarizeReport(rep).items.map(i => i.id), reason).toEqual(['c1']);
      expect(splitNotSent(rep, []).notNeeded, reason).toEqual([]);
    }
    for (const outcome of ['busy', 'failed'] as const) {
      const rep: RestoreReport = { allRestored: false, items: [{ id: 'c1', path: C, outcome, message: '' }] };
      expect(summarizeReport(rep), outcome).toMatchObject({ done: 0, notDone: 1 });
      expect(splitNotSent(rep, []).notNeeded, outcome).toEqual([]);
    }
  });

  it('lineDiff：3000 行改一行——增删各 1、行号是整份文件里的行号、保留所有相同行供视图折叠（直接调 diffLines 会得到 3000 删加 3000 增）', () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`);
    const next = [...lines]; next[1499] = 'line 1500 changed';
    const d = lineDiff(lines.join('\n') + '\n', next.join('\n') + '\n');
    expect(d.tooLarge).toBe(false);
    if (d.tooLarge) return;
    expect([d.add, d.del, d.oldLines, d.newLines]).toEqual([1, 1, 3000, 3000]);
    expect(d.lines.filter(l => l.type === 'del')).toEqual([{ type: 'del', text: 'line 1500', oldNo: 1500 }]);
    expect(d.lines.filter(l => l.type === 'add')).toEqual([{ type: 'add', text: 'line 1500 changed', newNo: 1500 }]);
    expect(d.lines.filter(l => l.type === 'ctx').map(l => l.oldNo)).toEqual(Array.from({ length: 3000 }, (_, i) => i + 1).filter(n => n !== 1500));
    expect(d.lines).toHaveLength(3001);
    // 对照：直接调 diffLines 退成了整份删除加整份新增
    expect(countAddDel(diffLines(lines.join('\n'), next.join('\n')))).toEqual({ add: 3000, del: 3000 });
  });

  it('lineDiff：中间删掉一个空行不被吃掉；两侧各 2500 行且逐行不同 → tooLarge 带两侧行数；小文件与 diffLines 的增删数相同；截断时只剥前缀', () => {
    const blank = lineDiff('a\n\nb\n', 'a\nb\n');
    expect(blank.tooLarge).toBe(false);
    if (!blank.tooLarge) expect([blank.add, blank.del]).toEqual([0, 1]);
    const a = Array.from({ length: 2500 }, (_, i) => `a${i}`).join('\n'); const b = Array.from({ length: 2500 }, (_, i) => `b${i}`).join('\n');
    expect(lineDiff(a, b)).toEqual({ tooLarge: true, oldLines: 2500, newLines: 2500 });
    const small = lineDiff('x\ny\nz\nw\n', 'x\nY\nz\nv\nw\n');
    const ref = countAddDel(diffLines('x\ny\nz\nw\n', 'x\nY\nz\nv\nw\n'));
    expect(small.tooLarge).toBe(false);
    if (!small.tooLarge) expect({ add: small.add, del: small.del }).toEqual(ref);
    // 内容没变：没有差分行
    const same = lineDiff('p\nq\n', 'p\nq\n');
    if (!same.tooLarge) expect(same).toMatchObject({ add: 0, del: 0, lines: [] });
    // 两侧都被截断：最后半行丢掉，尾部不当成相同后缀去剥
    const t = lineDiff('h1\nh2\nold\ntail-ha', 'h1\nh2\nnew\ntail-ha', { oldTruncated: true, newTruncated: true });
    if (!t.tooLarge) expect([t.add, t.del, t.oldLines]).toEqual([1, 1, 3]);
  });

  it('lineDiff：只改了行尾符或文件末尾换行的改动——增删都是 0，但 eolChanged 数得出来；文字与行尾一起变时两样都报', () => {
    const eol = (a: string, b: string, o = {}) => { const d = lineDiff(a, b, o); if (d.tooLarge) throw new Error('不该超限'); return d; };
    // CRLF 文件整份写成 LF：三行的行尾都变了
    expect(eol('alpha\r\nbeta\r\ngamma\r\n', 'alpha\nbeta\ngamma\n')).toMatchObject({ add: 0, del: 0, lines: [], eolChanged: 3 });
    // 只去掉 / 加上文件末尾的换行
    expect(eol('a\nb\n', 'a\nb')).toMatchObject({ add: 0, del: 0, eolChanged: 1 });
    expect(eol('a\nb', 'a\nb\n')).toMatchObject({ add: 0, del: 0, eolChanged: 1 });
    // 老式 CR 行尾
    expect(eol('a\rb\r', 'a\nb\n')).toMatchObject({ add: 0, del: 0, eolChanged: 2 });
    // 改了一行文字，同时全文行尾从 CRLF 换成 LF：增删各 1，另外两行只是行尾不同
    expect(eol('a\r\nb\r\nc\r\n', 'a\nB\nc\n')).toMatchObject({ add: 1, del: 1, eolChanged: 2 });
    // 中间段里的相同行也比（前后缀都剥不掉的时候）
    expect(eol('x\r\nkeep\r\ny\r\n', 'X\nkeep\nY\n')).toMatchObject({ add: 2, del: 2, eolChanged: 1 });
    // 混合行尾的文件里只有一行的行尾变了
    expect(eol('a\r\nb\nc\r\n', 'a\r\nb\r\nc\r\n')).toMatchObject({ add: 0, del: 0, eolChanged: 1 });
    // 内容与行尾都没变：0；普通的文字改动：0
    expect(eol('p\r\nq\r\n', 'p\r\nq\r\n').eolChanged).toBe(0);
    expect(eol('one\ntwo\nthree\n', 'one\nTWO\nthree\n').eolChanged).toBe(0);
    // 新建文件（改动前是空）：没有可比的行
    expect(eol('', 'a\r\nb\r\n')).toMatchObject({ add: 2, del: 0, eolChanged: 0 });
    // 行尾符与切出来的行一一对应：行数与 splitLines 相同的文本上逐行比才有意义（末尾空行、只有换行的文本）
    for (const s of ['', 'a', 'a\n', 'a\n\n', '\n', '\n\n', 'a\r\n\r\nb', 'a\rb\r\nc\n']) {
      const d = eol(s, s.replace(/\r\n|\r/g, '\n'));
      expect([d.add, d.del], JSON.stringify(s)).toEqual([0, 0]);
      expect(d.oldLines, JSON.stringify(s)).toBe(splitLines(s).length);
      expect(d.eolChanged, JSON.stringify(s)).toBe((s.match(/\r\n|\r/g) ?? []).length);
    }
  });

  it('noLineChangeNote：逐行比没有增删时每种情形一句不同的话，只说判得出来的事', () => {
    const base = { beforeExists: true, rightExists: true, sameHash: false, eolChanged: 0, office: false, truncated: false };
    expect(noLineChangeNote({ ...base, eolChanged: 3 })).toBe('文字相同，只有行尾符或文件末尾的换行不同。');
    expect(noLineChangeNote({ ...base, office: true })).toContain('版式');
    expect(noLineChangeNote({ ...base, office: true, eolChanged: 2 })).not.toContain('行尾');   // 提取出的文字比不出原文件的行尾
    expect(noLineChangeNote({ ...base, truncated: true })).toContain('没有比较');
    expect(noLineChangeNote({ ...base, sameHash: true })).toBe('两侧的内容完全相同。');
    expect(noLineChangeNote(base)).toContain('字节不同');
    expect(noLineChangeNote({ ...base, beforeExists: false })).toContain('不存在');
    const all = [base, { ...base, eolChanged: 1 }, { ...base, office: true }, { ...base, truncated: true }, { ...base, sameHash: true },
      { ...base, beforeExists: false }, { ...base, rightExists: false }].map(noLineChangeNote);
    expect(new Set(all).size).toBe(all.length);
    // 没有比出行尾差别时不说「只有行尾符不同」
    for (const o of [base, { ...base, office: true }, { ...base, sameHash: true }]) expect(noLineChangeNote(o)).not.toContain('只有行尾符');
  });

  it('describeVerdict 全表：每个结论一句不为空、互不相同；该提「另存」的都提；superseded 跨会话时换一句', () => {
    const all: RestoreVerdict[] = [
      { kind: 'ready', action: 'overwrite' }, { kind: 'ready', action: 'delete' },
      ...(['modified', 'missing', 'replaced', 'identity-changed', 'read-only', 'hard-linked', 'not-a-file', 'unreadable'] as const).map((reason): RestoreVerdict => ({ kind: 'conflict', reason })),
      { kind: 'conflict', reason: 'superseded', later: [{ id: 'x', sessionId: 'S1' }] },
      ...(['pruned', 'already-restored', 'not-applied', 'unknown-state', 'blob-missing', 'blob-corrupt', 'run-active', 'rule-blocked', 'unsettled', 'session-deleted'] as const).map((reason): RestoreVerdict => ({ kind: 'unavailable', reason })),
    ];
    const texts = all.map(v => describeVerdict(v, 'S1'));
    expect(texts.every(t => t.length > 0)).toBe(true);
    expect(new Set(texts).size).toBe(texts.length);
    for (const reason of ['modified', 'missing', 'replaced', 'hard-linked'] as const) expect(describeVerdict({ kind: 'conflict', reason })).toContain('另存');
    const sup: RestoreVerdict = { kind: 'conflict', reason: 'superseded', later: [{ id: 'x', sessionId: 'S2' }, { id: 'y', sessionId: 'S1' }] };
    expect(describeVerdict(sup, 'S1')).toContain('另一个会话');
    expect(describeVerdict(sup, 'S1')).toContain('2 次改动');
    expect(describeVerdict(sup)).not.toContain('另一个会话');
    // 界面上没有「选中」这种操作：说的是真有的两条路（先恢复后面的；或在审阅面板里连同它们一起恢复）
    expect(describeVerdict({ kind: 'conflict', reason: 'superseded', later: [{ id: 'y', sessionId: 'S1' }] }, 'S1')).toBe('这个文件之后还有 1 次改动。要先恢复后面的改动，或连同它们一起恢复。');
    for (const t of texts) expect(t).not.toContain('选中');
  });

  it('collectArtifacts 带 skipToolUseIds：被跳过的不列；不传第四参时结果与不带选项逐字段相同', () => {
    const messages = [
      { role: 'assistant', parts: [
        { type: 'toolUse', value: { toolUseId: 't1', name: 'file_write', input: JSON.stringify({ path: 'a.txt', content: 'x' }) } },
        { type: 'toolUse', value: { toolUseId: 't2', name: 'file_write', input: JSON.stringify({ path: 'b.txt', content: 'y' }) } },
      ] },
      { role: 'user', parts: [{ type: 'toolResult', value: { toolUseId: 't1', success: true } }, { type: 'toolResult', value: { toolUseId: 't2', success: true } }] },
    ];
    const cards = [{ toolUseId: 't3', name: 'file_write', input: JSON.stringify({ path: 'c.txt', content: 'z' }), success: true }];
    const plain = collectArtifacts(messages, cards, false);
    expect(plain.map(a => a.path)).toEqual(['a.txt', 'b.txt', 'c.txt']);
    expect(collectArtifacts(messages, cards, false, {})).toEqual(plain);
    expect(collectArtifacts(messages, cards, false, { skipToolUseIds: new Set(['t1', 't3']) }).map(a => a.path)).toEqual(['b.txt']);
  });

  it('collectArtifacts 带 settledOnly：结果还没到的调用（正在跑的回合里没配到结果的、实时卡片上 success 还没有的）不列；不带时照旧列', () => {
    const messages = [
      { role: 'user', parts: [{ type: 'text', value: '改一下' }] },
      { role: 'assistant', parts: [
        { type: 'toolUse', value: { toolUseId: 'done', name: 'file_write', input: JSON.stringify({ path: 'done.txt', content: 'x' }) } },
        { type: 'toolUse', value: { toolUseId: 'waiting', name: 'file_write', input: JSON.stringify({ path: 'waiting.txt', content: 'y' }) } },
      ] },
    ];
    const cards = [
      { toolUseId: 'done', name: 'file_write', input: JSON.stringify({ path: 'done.txt', content: 'x' }), success: true },
      { toolUseId: 'waiting', name: 'file_write', input: JSON.stringify({ path: 'waiting.txt', content: 'y' }) },   // 还在等审批：没有 success
    ];
    expect(collectArtifacts(messages, cards, true).map(a => a.path).sort()).toEqual(['done.txt', 'waiting.txt']);
    expect(collectArtifacts(messages, cards, true, { settledOnly: true }).map(a => a.path)).toEqual(['done.txt']);
    // 回合结束、结果落库之后：成功的照常列
    const settled = [...messages, { role: 'user', parts: [{ type: 'toolResult', value: { toolUseId: 'done', success: true } }, { type: 'toolResult', value: { toolUseId: 'waiting', success: true } }] }];
    expect(collectArtifacts(settled, [], false, { settledOnly: true }).map(a => a.path).sort()).toEqual(['done.txt', 'waiting.txt']);
  });
});

describe('F08 U 组：ChangeListView（真实渲染出的可见文字）', () => {
  it('两个 run：按新到旧出现两个组头与各自的文件路径；有 shell 调用的组出现「不在记录里」那一句，全为 0 的组不出现', async () => {
    const text = visibleText(await renderSfc(LIST_VIEW, listProps()));
    const i2 = text.indexOf('第 2 次运行'); const i1 = text.indexOf('第 1 次运行');
    expect(i2).toBeGreaterThanOrEqual(0);
    expect(i1).toBeGreaterThan(i2);
    expect(text.indexOf('notes/second.md')).toBeGreaterThan(i2);
    expect(text.indexOf('notes/second.md')).toBeLessThan(i1);
    expect(text.indexOf('report.docx')).toBeGreaterThan(i1);
    expect(text.indexOf('src/main.ts')).toBeGreaterThan(i1);
    expect(text.match(/不在记录里，也不能在这里撤销/g) ?? []).toHaveLength(1);   // 只有第 1 次运行那一组（页脚的范围说明是另一句）
    expect(text.indexOf('这次运行还执行了 1 次 shell 命令')).toBeGreaterThan(i1);
    expect(text.match(/恢复这次运行…/g) ?? []).toHaveLength(2);
  });

  it('页脚：范围说明全文、占用与上限；受保护内容超限时提示调大上限', async () => {
    const text = visibleText(await renderSfc(LIST_VIEW, listProps()));
    expect(text).toContain(CHECKPOINT_SCOPE_NOTE);
    expect(text).toContain('检查点占用 152 MB / 1 GB · 保留 30 天');
    expect(text).not.toContain('请调大上限');
    const over = twoRuns(); over.usage = { ...usage, overQuota: true };
    expect(visibleText(await renderSfc(LIST_VIEW, listProps({ list: over })))).toContain('请调大上限');
  });

  it('预检：2 个就绪、1 个冲突——确认按钮上的数字是 2，冲突项的原因句可见；没有就绪项时没有确认按钮', async () => {
    const modified: RestoreVerdict = { kind: 'conflict', reason: 'modified' };
    const precheck: RestorePrecheck[] = [
      { id: 'c1', path: 'C:\\work\\src\\main.ts', verdict: READY, message: describeVerdict(READY) },
      { id: 'c2', path: 'C:\\work\\report.docx', verdict: modified, message: describeVerdict(modified) },
      { id: 'cx', path: 'C:\\work\\x.txt', verdict: { kind: 'ready', action: 'delete' }, message: 'ok' },
    ];
    const text = visibleText(await renderSfc(LIST_VIEW, listProps({ expandedRunId: 'RUN-1', precheck })));
    expect(text).toContain('恢复可恢复的 2 个文件');
    expect(text).toContain('可恢复 2 个；不能恢复 1 个');
    expect(text).toContain('文件在这次改动之后又被修改过');
    // 不能恢复的那一项按清单里的相对路径显示（右栏窄，绝对路径一截断就看不出是哪个文件），后面跟着原因
    expect(text.slice(text.indexOf('可恢复 2 个'))).toMatch(/report\.docx 文件在这次改动之后又被修改过/);
    expect(text).not.toContain('C:\\work\\report.docx');
    const none =visibleText(await renderSfc(LIST_VIEW, listProps({ expandedRunId: 'RUN-1', precheck: [precheck[1]] })));
    expect(none).not.toContain('恢复可恢复的');
    expect(none).toContain('可恢复 0 个');
    // 预检面板只挂在展开的那一组上
    expect(visibleText(await renderSfc(LIST_VIEW, listProps({ expandedRunId: null, precheck })))).not.toContain('恢复可恢复的');
  });

  it('预检：同一文件在这次运行里改了两次——两条都算可恢复（按文件数是 1 个），写明会连同之后的改动一起恢复，不出现「要先恢复后面的改动」', async () => {
    const list = twoRuns();
    // 第 1 次运行里 src/main.ts 被改了两次（c1 较早、c4 较晚），另有 report.docx
    const again = change({ id: 'c4', displayPath: 'src/main.ts', seq: 4 });
    list.groups[1].changes.unshift(again);
    const sup: RestoreVerdict = { kind: 'conflict', reason: 'superseded', later: [{ id: 'c4', sessionId: 'S1' }] };
    const precheck: RestorePrecheck[] = [
      { id: 'c4', path: 'C:\\work\\src\\main.ts', verdict: READY, message: describeVerdict(READY) },
      { id: 'c2', path: 'C:\\work\\report.docx', verdict: { kind: 'ready', action: 'delete' }, message: 'ok' },
      { id: 'c1', path: 'C:\\work\\src\\main.ts', verdict: sup, message: describeVerdict(sup, 'S1') },
    ];
    const text = visibleText(await renderSfc(LIST_VIEW, listProps({ list, expandedRunId: 'RUN-1', precheck })));
    expect(text).toContain('可恢复 2 个；不能恢复 0 个');
    expect(text).toContain('恢复可恢复的 2 个文件');                      // 三条记录、两个文件
    expect(text).toContain('共 3 次改动：同一个文件在这次运行里改了多次的，会连同之后的改动一起恢复');
    expect(text).not.toContain('要先恢复后面的改动');                    // 那一条不在「不能恢复」里
    // 对照：最新的一次被用户改过——整条链都不能恢复，原因逐条列出，没有确认按钮
    const modified: RestoreVerdict = { kind: 'conflict', reason: 'modified' };
    const broken = [{ ...precheck[0], verdict: modified, message: describeVerdict(modified) }, precheck[2]];
    const t2 = visibleText(await renderSfc(LIST_VIEW, listProps({ list, expandedRunId: 'RUN-1', precheck: broken })));
    expect(t2).toContain('可恢复 0 个；不能恢复 2 个');
    expect(t2).toContain('要先恢复后面的改动，或连同它们一起恢复');
    expect(t2).not.toContain('恢复可恢复的');
    expect(t2).not.toContain('会连同之后的改动一起恢复');
    // 结果：同一文件的两条都恢复了，按文件数是 2 个
    const report: RestoreReport = { allRestored: true, items: precheck.map(p => ({ id: p.id, path: p.path, outcome: p.id === 'c2' ? 'deleted' as const : 'restored' as const, message: '已恢复。' })) };
    const t3 = visibleText(await renderSfc(LIST_VIEW, listProps({ list, expandedRunId: 'RUN-1', precheck, report })));
    expect(t3).toContain('已恢复 2 个文件。');
    expect(t3).not.toContain('预检时不能恢复');
    expect(text).not.toContain('回不到这次运行之前');                    // 整条链都发得出去：没有这一句
  });

  it('预检与结果：同一文件改了三次、最早那条的检查点已被清理（[就绪, 之后还有改动→一起发, 已清理]）——确认之前写明这个文件回不到这次运行之前；后两条都恢复了，标题也不把它数成「已恢复」', async () => {
    const list = twoRuns();
    // 第 1 次运行：c5、c4（新）与 c1（最早）都是 src/main.ts，另有新建的 report.docx（c2）
    list.groups[1].changes.unshift(change({ id: 'c5', displayPath: 'src/main.ts', seq: 5 }), change({ id: 'c4', displayPath: 'src/main.ts', seq: 4 }));
    const sup: RestoreVerdict = { kind: 'conflict', reason: 'superseded', later: [{ id: 'c5', sessionId: 'S1' }] };
    const pruned: RestoreVerdict = { kind: 'unavailable', reason: 'pruned' };
    const precheck: RestorePrecheck[] = [
      { id: 'c5', path: 'C:\\work\\src\\main.ts', verdict: READY, message: describeVerdict(READY) },
      { id: 'c4', path: 'C:\\work\\src\\main.ts', verdict: sup, message: describeVerdict(sup, 'S1') },
      { id: 'c2', path: 'C:\\work\\report.docx', verdict: { kind: 'ready', action: 'delete' }, message: 'ok' },
      // 已清理的记录没有重新解析路径，带的是写入时的路径（这里只差大小写）：归到哪个文件要按清单里的路径身份键
      { id: 'c1', path: 'C:\\work\\src\\Main.ts', verdict: pruned, message: describeVerdict(pruned) },
    ];
    const text = visibleText(await renderSfc(LIST_VIEW, listProps({ list, expandedRunId: 'RUN-1', precheck })));
    expect(text).toContain('可恢复 2 个；不能恢复 1 个');
    expect(text).toContain('src/main.ts 这次改动的检查点已按容量或保留期清理，不能恢复。');
    expect(text).toContain('其中 1 个文件回不到这次运行之前：更早的改动不能恢复（原因见上），只会恢复后面的几次改动，文件停在中间的版本。');
    // 这一句在确认按钮之前
    expect(text.indexOf('回不到这次运行之前')).toBeLessThan(text.indexOf('恢复可恢复的 2 个文件'));
    expect(text.indexOf('回不到这次运行之前')).toBeGreaterThan(0);

    // 引擎对发出去的三条（c5、c4、c2）都报成功：src/main.ts 停在这次运行第一次写入之后的版本，只有 report.docx 算恢复
    const report: RestoreReport = {
      allRestored: true,
      items: [
        { id: 'c5', path: 'C:\\work\\src\\main.ts', outcome: 'restored', message: '已恢复到这次改动之前的内容。' },
        { id: 'c4', path: 'C:\\work\\src\\main.ts', outcome: 'restored', message: '已恢复到这次改动之前的内容。' },
        { id: 'c2', path: 'C:\\work\\report.docx', outcome: 'deleted', message: '已删除这次改动新建的文件。' },
      ],
    };
    const done = visibleText(await renderSfc(LIST_VIEW, listProps({ list, expandedRunId: 'RUN-1', precheck, report })));
    expect(done).toContain('已恢复 1 个文件，另有 1 个没有恢复。其中 1 个只恢复了后面的几次改动，文件停在中间的版本。');
    expect(done).not.toContain('已恢复 2 个文件');
    // 没发的那一条照旧逐条列出，带原因。它属于 src/main.ts，标题已经把这个文件数进「另有 1 个没有恢复」：
    // 小标题不再另算一个（R2-1：以前这里是「另有 1 个没有恢复（预检时不能恢复）：」，同一个文件数了两遍）
    expect(done).toContain('上面的文件里，有 1 次改动这次没有恢复（预检时不能恢复）：');
    expect(done.match(/另有 \d+ 个没有恢复/g)).toEqual(['另有 1 个没有恢复']);
    expect(done).toContain('这次改动的检查点已按容量或保留期清理，不能恢复。');
    expect(done).toContain('模型不会自动得知这次恢复，继续对话时请告诉它。');   // 文件确实变了

    // 对照：不能恢复的那一条属于别的文件（那个文件一条都没发）——没有「回不到」这一句，标题只数发出去的
    const elsewhere: RestorePrecheck[] = [precheck[0], precheck[1], { ...precheck[3], id: 'c2', path: 'C:\\work\\report.docx' }];
    const t2 = visibleText(await renderSfc(LIST_VIEW, listProps({ list, expandedRunId: 'RUN-1', precheck: elsewhere })));
    expect(t2).toContain('可恢复 1 个；不能恢复 1 个');
    expect(t2).not.toContain('回不到这次运行之前');
    const r2: RestoreReport = { allRestored: true, items: report.items.slice(0, 2) };
    const d2 = visibleText(await renderSfc(LIST_VIEW, listProps({ list, expandedRunId: 'RUN-1', precheck: elsewhere, report: r2 })));
    expect(d2).toContain('已恢复 1 个文件。');
    expect(d2).not.toContain('停在中间的版本');
  });

  it('恢复结果是部分冲突：逐项结果可见，不说「全部恢复」；有成功项时提示模型不会自动得知', async () => {
    const report: RestoreReport = {
      allRestored: false,
      items: [
        { id: 'c1', path: 'C:\\work\\src\\main.ts', outcome: 'restored', message: '已恢复到这次改动之前的内容。' },
        { id: 'c2', path: 'C:\\work\\report.docx', outcome: 'conflict', verdict: { kind: 'conflict', reason: 'modified' }, message: '文件在这次改动之后又被修改过。恢复会盖掉那些修改，所以没有执行。' },
      ],
    };
    const text = visibleText(await renderSfc(LIST_VIEW, listProps({ expandedRunId: 'RUN-1', report })));
    expect(text).toContain('已恢复 1 个文件，另有 1 个没有恢复。');
    expect(text).toContain('已恢复到这次改动之前的内容。');
    expect(text).toContain('恢复会盖掉那些修改，所以没有执行。');
    expect(text).not.toContain('全部恢复');
    expect(text).toContain('模型不会自动得知这次恢复，继续对话时请告诉它。');
    // 确认时只发了就绪的那几项：预检时不能恢复的照样列在结果里
    const blocked: RestorePrecheck[] = [{ id: 'c2', path: 'C:\\work\\report.docx', verdict: { kind: 'conflict', reason: 'read-only' }, message: describeVerdict({ kind: 'conflict', reason: 'read-only' }) }];
    const onlyDone: RestoreReport = { allRestored: true, items: [report.items[0]] };
    const both = visibleText(await renderSfc(LIST_VIEW, listProps({ expandedRunId: 'RUN-1', report: onlyDone, precheck: blocked })));
    expect(both).toContain('已恢复 1 个文件。');
    expect(both).toContain('另有 1 个没有恢复（预检时不能恢复）：');
    expect(both).toContain('文件现在是只读的，没有改动它。');
    expect(both).not.toContain('恢复可恢复的');
    const failed: RestoreReport = { allRestored: false, items: [report.items[1]] };
    expect(visibleText(await renderSfc(LIST_VIEW, listProps({ expandedRunId: 'RUN-1', report: failed })))).not.toContain('模型不会自动得知');
  });

  it('恢复结果对同一个文件只计一次（R2-1）：链头预检时不能恢复、后几条恢复成功的文件只在标题里计数，它没发的那一条列在「上面的文件里」一节、不再另算一个；一条都没发的文件才进「另有 N 个没有恢复」，按文件数，几个数字加起来等于这次运行的文件数', async () => {
    const list = twoRuns();
    // 第 1 次运行：src/main.ts 改了三次（c5、c4、c1），新建的 report.docx（c2）；另有两个一条都发不出去的文件——a.txt（c7、c6 两条）与 b.txt（c8）
    list.groups[1].changes.unshift(
      change({ id: 'c8', displayPath: 'b.txt', seq: 8 }), change({ id: 'c7', displayPath: 'a.txt', seq: 7 }), change({ id: 'c6', displayPath: 'a.txt', seq: 6 }),
      change({ id: 'c5', displayPath: 'src/main.ts', seq: 5 }), change({ id: 'c4', displayPath: 'src/main.ts', seq: 4 }),
    );
    const sup = (later: string): RestoreVerdict => ({ kind: 'conflict', reason: 'superseded', later: [{ id: later, sessionId: 'S1' }] });
    const pruned: RestoreVerdict = { kind: 'unavailable', reason: 'pruned' };
    const modified: RestoreVerdict = { kind: 'conflict', reason: 'modified' };
    const readOnly: RestoreVerdict = { kind: 'conflict', reason: 'read-only' };
    const precheck: RestorePrecheck[] = [
      { id: 'c8', path: 'C:\\work\\b.txt', verdict: readOnly, message: describeVerdict(readOnly) },
      { id: 'c7', path: 'C:\\work\\a.txt', verdict: modified, message: describeVerdict(modified) },
      { id: 'c6', path: 'C:\\work\\a.txt', verdict: sup('c7'), message: describeVerdict(sup('c7'), 'S1') },
      { id: 'c5', path: 'C:\\work\\src\\main.ts', verdict: READY, message: describeVerdict(READY) },
      { id: 'c4', path: 'C:\\work\\src\\main.ts', verdict: sup('c5'), message: describeVerdict(sup('c5'), 'S1') },
      { id: 'c2', path: 'C:\\work\\report.docx', verdict: { kind: 'ready', action: 'delete' }, message: 'ok' },
      { id: 'c1', path: 'C:\\work\\src\\main.ts', verdict: pruned, message: describeVerdict(pruned) },
    ];
    const report: RestoreReport = {
      allRestored: true,
      items: [
        { id: 'c5', path: 'C:\\work\\src\\main.ts', outcome: 'restored', message: '已恢复到这次改动之前的内容。' },
        { id: 'c4', path: 'C:\\work\\src\\main.ts', outcome: 'restored', message: '已恢复到这次改动之前的内容。' },
        { id: 'c2', path: 'C:\\work\\report.docx', outcome: 'deleted', message: '已删除这次改动新建的文件。' },
      ],
    };
    const text = visibleText(await renderSfc(LIST_VIEW, listProps({ list, expandedRunId: 'RUN-1', precheck, report })));
    const panel = text.slice(text.indexOf('已恢复 1 个文件'));
    // 标题：report.docx 恢复了；src/main.ts 停在中间版本，算在「另有 1 个没有恢复」里
    expect(panel).toContain('已恢复 1 个文件，另有 1 个没有恢复。其中 1 个只恢复了后面的几次改动，文件停在中间的版本。');
    // src/main.ts 没发的那一条：逐条列出、带原因，但不再另算一个「没有恢复」的文件
    const same = panel.indexOf('上面的文件里，有 1 次改动这次没有恢复（预检时不能恢复）：');
    const other = panel.indexOf('另有 2 个没有恢复（预检时不能恢复）：');
    expect(same).toBeGreaterThan(0);
    expect(other).toBeGreaterThan(same);
    expect(panel.slice(same, other)).toContain('src/main.ts 这次改动的检查点已按容量或保留期清理，不能恢复。');
    expect(panel.slice(same, other)).not.toContain('a.txt');
    // 一条都没发的两个文件（三条记录）：按文件数是 2，逐条列在这一节
    const rest = panel.slice(other);
    expect(rest).toContain('b.txt 文件现在是只读的，没有改动它。');
    expect(rest.match(/a\.txt /g) ?? []).toHaveLength(2);
    expect(rest).not.toContain('src/main.ts');
    // 每个文件恰好数一次：这次运行 4 个文件 = 已恢复 1 + 标题里没有恢复的 1 + 这里的 2
    expect(panel.match(/另有 \d+ 个没有恢复/g)).toEqual(['另有 1 个没有恢复', '另有 2 个没有恢复']);
    expect(panel).not.toContain('另有 4 个');
  });

  it('恢复结果：以前已经恢复过的改动不算「没有恢复」——先在审阅面板单独恢复了 report.docx 的那次改动，再点「恢复这次运行」：标题是「已恢复 1 个文件。」，页面上不出现「没有恢复」，那一条列在「不需要恢复」一节；同一个文件里更早的一条恢复过的同理；真的没有恢复的文件照旧计数', async () => {
    const done: RestoreVerdict = { kind: 'unavailable', reason: 'already-restored' };
    const pruned: RestoreVerdict = { kind: 'unavailable', reason: 'pruned' };
    const ok = (id: string, path: string): RestoreReport['items'][number] => ({ id, path, outcome: 'restored', message: '已恢复到这次改动之前的内容。' });
    const panelOf = (text: string): string => text.slice(text.indexOf('已恢复 1 个文件'));

    // 一、第 1 次运行：report.docx（c2）之前已单独恢复，src/main.ts（c1）就绪并恢复成功
    const list = twoRuns();
    list.groups[1].changes[0] = { ...list.groups[1].changes[0], state: 'restored', restoredAt: 1_790_000_300 };
    const precheck: RestorePrecheck[] = [
      { id: 'c2', path: 'C:\\work\\report.docx', verdict: done, message: describeVerdict(done) },
      { id: 'c1', path: 'C:\\work\\src\\main.ts', verdict: READY, message: describeVerdict(READY) },
    ];
    const report: RestoreReport = { allRestored: true, items: [ok('c1', 'C:\\work\\src\\main.ts')] };
    const panel = panelOf(visibleText(await renderSfc(LIST_VIEW, listProps({ list, expandedRunId: 'RUN-1', precheck, report }))));
    expect(panel).toContain('已恢复 1 个文件。');
    // 以前这里是「另有 1 个没有恢复（预检时不能恢复）： report.docx 这次改动已经恢复过了。」——一个早就恢复好的文件被说成没有恢复
    const upTo = panel.slice(0, panel.indexOf('模型不会自动得知'));
    expect(upTo).not.toContain('没有恢复');
    expect(upTo).not.toContain('不能恢复');
    expect(upTo).toContain('有 1 次改动不需要恢复（之前已经恢复过，或当时没有写成）：');
    expect(upTo.slice(upTo.indexOf('不需要恢复'))).toContain('report.docx 这次改动已经恢复过了。');

    // 二、同一个文件：src/main.ts 较早的一条（c1）之前恢复过，之后这次运行又改了它一次（c4），c4 就绪并恢复成功
    const same = twoRuns();
    same.groups[1].changes = [change({ id: 'c4', displayPath: 'src/main.ts', seq: 4 }), change({ id: 'c1', displayPath: 'src/main.ts', seq: 1, state: 'restored', restoredAt: 1_790_000_300 })];
    const pre2: RestorePrecheck[] = [
      { id: 'c4', path: 'C:\\work\\src\\main.ts', verdict: READY, message: describeVerdict(READY) },
      { id: 'c1', path: 'C:\\work\\src\\main.ts', verdict: done, message: describeVerdict(done) },
    ];
    const p2 = panelOf(visibleText(await renderSfc(LIST_VIEW, listProps({ list: same, expandedRunId: 'RUN-1', precheck: pre2, report: { allRestored: true, items: [ok('c4', 'C:\\work\\src\\main.ts')] } }))));
    expect(p2).toContain('已恢复 1 个文件。');
    expect(p2).not.toContain('上面的文件里');
    expect(p2.slice(0, p2.indexOf('模型不会自动得知'))).not.toContain('没有恢复');
    expect(p2).toContain('有 1 次改动不需要恢复（之前已经恢复过，或当时没有写成）：');

    // 三、混在一起：b.txt（c8）的检查点已清理——真的没有恢复，照旧「另有 1 个」；report.docx（c2）恢复过——不算，数字不变成 2
    const mixed = twoRuns();
    mixed.groups[1].changes.unshift(change({ id: 'c8', displayPath: 'b.txt', seq: 8 }));
    const pre3: RestorePrecheck[] = [{ id: 'c8', path: 'C:\\work\\b.txt', verdict: pruned, message: describeVerdict(pruned) }, ...precheck];
    const p3 = panelOf(visibleText(await renderSfc(LIST_VIEW, listProps({ list: mixed, expandedRunId: 'RUN-1', precheck: pre3, report }))));
    expect(p3.match(/另有 \d+ 个没有恢复/g)).toEqual(['另有 1 个没有恢复']);
    const other = p3.indexOf('另有 1 个没有恢复（预检时不能恢复）：');
    const needless = p3.indexOf('有 1 次改动不需要恢复（之前已经恢复过，或当时没有写成）：');
    expect(other).toBeGreaterThan(0);
    expect(needless).toBeGreaterThan(other);
    expect(p3.slice(other, needless)).toContain('b.txt 这次改动的检查点已按容量或保留期清理，不能恢复。');
    expect(p3.slice(other, needless)).not.toContain('report.docx');
    expect(p3.slice(needless)).toContain('report.docx 这次改动已经恢复过了。');
  });

  it('恢复结果（过期预检）：预检面板开着时先在审阅面板单独恢复了其中一条，再点确认——那条照样发了出去，引擎回报「已经恢复过了」：它不算「没有恢复」，不列在标题下面那一列、不标成出错的颜色，归到「不需要恢复」一节；只发了这一条时标题不说「N 个没有恢复」；整条链里最新一条先恢复过时不说「停在中间的版本」；它更早的一条预检时就不能恢复的，那个文件只在「另有 N 个」里数一次', async () => {
    const done: RestoreVerdict = { kind: 'unavailable', reason: 'already-restored' };
    const pruned: RestoreVerdict = { kind: 'unavailable', reason: 'pruned' };
    const ok = (id: string, path: string): RestoreReport['items'][number] => ({ id, path, outcome: 'restored', message: '已恢复到这次改动之前的内容。' });
    // 引擎对发出去、但已经恢复过的记录给的形态（restore.ts itemOf；既有用例 R21）
    const stale = (id: string, path: string): RestoreReport['items'][number] => ({ id, path, outcome: 'unavailable', verdict: done, message: describeVerdict(done) });
    const ready = (id: string, path: string): RestorePrecheck => ({ id, path, verdict: READY, message: describeVerdict(READY) });
    const NEEDLESS = '次改动不需要恢复（之前已经恢复过，或当时没有写成）：';
    const MAIN = 'C:\\work\\src\\main.ts'; const DOCX = 'C:\\work\\report.docx';

    // 一、第 1 次运行：预检时 report.docx（c2）与 src/main.ts（c1）都就绪；确认之前 c2 已单独恢复。两条都发了
    const precheck: RestorePrecheck[] = [ready('c2', DOCX), ready('c1', MAIN)];
    const report: RestoreReport = { allRestored: false, items: [stale('c2', DOCX), ok('c1', MAIN)] };
    const html = await renderSfc(LIST_VIEW, listProps({ expandedRunId: 'RUN-1', precheck, report }));
    const text = visibleText(html);
    const panel = text.slice(text.indexOf('已恢复 1 个文件'));
    // 以前这里是「已恢复 1 个文件，另有 1 个没有恢复。 report.docx 这次改动已经恢复过了。」
    expect(panel).toContain('已恢复 1 个文件。');
    const upTo = panel.slice(0, panel.indexOf('模型不会自动得知'));
    expect(upTo).not.toContain('没有恢复');
    expect(upTo).not.toContain('不能恢复');
    const needless = upTo.indexOf(`有 1 ${NEEDLESS}`);
    expect(needless).toBeGreaterThan(0);
    // 标题下面那一列只有真的动过的 src/main.ts；report.docx 只出现在「不需要恢复」一节
    expect(upTo.slice(0, needless)).toContain('src/main.ts 已恢复到这次改动之前的内容。');
    expect(upTo.slice(0, needless)).not.toContain('report.docx');
    expect(upTo.slice(needless)).toContain('report.docx 这次改动已经恢复过了。');
    // 不标成出错的颜色：整个页面上没有一行带 unavailable 这个类
    expect(html).not.toMatch(/class="[^"]*\bunavailable\b[^"]*"/);

    // 二、只发了一条、而它已经恢复过（src/main.ts 的那条预检时就是「已经恢复过」，没有发）：没有任何文件被动过
    const pre2: RestorePrecheck[] = [ready('c2', DOCX), { id: 'c1', path: MAIN, verdict: done, message: describeVerdict(done) }];
    const t2 = visibleText(await renderSfc(LIST_VIEW, listProps({ expandedRunId: 'RUN-1', precheck: pre2, report: { allRestored: false, items: [stale('c2', DOCX)] } })));
    const p2 = t2.slice(t2.indexOf('没有恢复任何文件'));
    // 以前是「没有恢复任何文件（1 个没有恢复）。」
    expect(p2).toContain('没有恢复任何文件：这次要恢复的改动都不需要恢复。');
    expect(p2).not.toContain('个没有恢复');
    expect(p2).toContain(`有 2 ${NEEDLESS}`);
    expect(p2).not.toContain('模型不会自动得知');                          // 文件一个字节没动

    // 三、src/main.ts 在这次运行里改了三次（c5、c4、c1），整条链都发了；最新的 c5 先单独恢复过，后两条恢复成功——文件回到运行之前
    const chain = twoRuns();
    chain.groups[1].changes = [change({ id: 'c5', displayPath: 'src/main.ts', seq: 5 }), change({ id: 'c4', displayPath: 'src/main.ts', seq: 4 }), change({ id: 'c1', displayPath: 'src/main.ts', seq: 1 })];
    const sup = (later: string[]): RestoreVerdict => ({ kind: 'conflict', reason: 'superseded', later: later.map(id => ({ id, sessionId: 'S1' })) });
    const pre3: RestorePrecheck[] = [
      ready('c5', MAIN),
      { id: 'c4', path: MAIN, verdict: sup(['c5']), message: describeVerdict(sup(['c5']), 'S1') },
      { id: 'c1', path: MAIN, verdict: sup(['c4', 'c5']), message: describeVerdict(sup(['c4', 'c5']), 'S1') },
    ];
    const t3 = visibleText(await renderSfc(LIST_VIEW, listProps({ list: chain, expandedRunId: 'RUN-1', precheck: pre3, report: { allRestored: false, items: [stale('c5', MAIN), ok('c4', MAIN), ok('c1', MAIN)] } })));
    const p3 = t3.slice(t3.indexOf('已恢复 1 个文件'));
    expect(p3).toContain('已恢复 1 个文件。');
    expect(p3).not.toContain('停在中间的版本');
    expect(p3.slice(0, p3.indexOf('模型不会自动得知'))).not.toContain('没有恢复');
    expect(p3).toContain(`有 1 ${NEEDLESS}`);

    // 四、b.txt 改了两次：较早的 c7 检查点已清理（预检时就不能恢复、没有发），较晚的 c8 预检时就绪、确认之前单独恢复了——
    // c7 的改动还留在文件里。b.txt 这次没有一条记录真的动手：标题不数它，它只在「另有 1 个没有恢复」里数一次
    const two = twoRuns();
    two.groups[1].changes.unshift(change({ id: 'c8', displayPath: 'b.txt', seq: 8 }), change({ id: 'c7', displayPath: 'b.txt', seq: 7 }));
    const pre4: RestorePrecheck[] = [ready('c8', 'C:\\work\\b.txt'), { id: 'c7', path: 'C:\\work\\b.txt', verdict: pruned, message: describeVerdict(pruned) }, ready('c1', MAIN)];
    const t4 = visibleText(await renderSfc(LIST_VIEW, listProps({ list: two, expandedRunId: 'RUN-1', precheck: pre4, report: { allRestored: false, items: [stale('c8', 'C:\\work\\b.txt'), ok('c1', MAIN)] } })));
    const p4 = t4.slice(t4.indexOf('已恢复 1 个文件'));
    expect(p4).toContain('已恢复 1 个文件。');
    expect(p4).not.toContain('上面的文件里');
    expect(p4.match(/另有 \d+ 个没有恢复/g)).toEqual(['另有 1 个没有恢复']);
    const other = p4.indexOf('另有 1 个没有恢复（预检时不能恢复）：');
    const last = p4.indexOf(`有 1 ${NEEDLESS}`);
    expect(other).toBeGreaterThan(0);
    expect(last).toBeGreaterThan(other);
    expect(p4.slice(0, other)).not.toContain('b.txt');
    expect(p4.slice(other, last)).toContain('b.txt 这次改动的检查点已按容量或保留期清理，不能恢复。');
    expect(p4.slice(last)).toContain('b.txt 这次改动已经恢复过了。');
  });

  it('已清理的行显示「已清理」；只有旧改动时只出「没有检查点的改动」一节、没有恢复入口；有错误时显示那一句、旧改动照常列', async () => {
    const pruned = twoRuns(); pruned.groups[1].changes[1] = { ...pruned.groups[1].changes[1], prunedAt: 1_790_000_900, beforeStored: false };
    expect(visibleText(await renderSfc(LIST_VIEW, listProps({ list: pruned })))).toContain('已清理');
    const legacy = [{ path: 'old/a.txt', kind: 'write' }, { path: 'old/b.txt', kind: 'edit', add: 2, del: 1 }];
    const only = visibleText(await renderSfc(LIST_VIEW, listProps({ list: { groups: [], coveredToolUseIds: [], truncated: false, usage }, legacy })));
    // 标题只说事实，原因是不排他的一句（「通常是」）：不把每一条都断定成旧版本或别的设备做的
    expect(only).toContain('没有检查点的改动 这些写入没有留下检查点记录，通常是升级之前、或在其它设备上执行的。这里只能查看当前文件，不能恢复。');
    expect(only).not.toContain('没有检查点的改动（升级之前，或在其它设备上执行）');
    expect(only).toContain('old/a.txt');
    expect(only).not.toContain('恢复这次运行');
    expect(only).not.toContain('本会话还没有文件改动');
    const err = visibleText(await renderSfc(LIST_VIEW, listProps({ list: null, legacy, error: '文件检查点只能在运行 DeskMinis 引擎的这台电脑上查看和恢复' })));
    expect(err).toContain('文件检查点只能在运行 DeskMinis 引擎的这台电脑上查看和恢复');
    expect(err).toContain('old/b.txt');
    // 清单没取到（远程连接）：这些写入有没有检查点根本不知道，不说「没有检查点」
    expect(err).toContain('本会话的文件写入（按工具调用记录）');
    expect(err).toContain('检查点清单没有取到');
    expect(err).not.toContain('没有检查点的改动');
    expect(err).not.toContain('升级之前');
    expect(visibleText(await renderSfc(LIST_VIEW, listProps({ list: null })))).toContain('本会话还没有文件改动');
    // 清单还没取回来：不抢着说「还没有文件改动」
    expect(visibleText(await renderSfc(LIST_VIEW, listProps({ list: null, loading: true })))).not.toContain('本会话还没有文件改动');
  });

  it('清单被截断（引擎只给最近 1000 条）时照实写明；没截断时不出这一句', async () => {
    const cut = twoRuns(); cut.truncated = true;
    expect(visibleText(await renderSfc(LIST_VIEW, listProps({ list: cut })))).toContain('只显示最近 1000 条改动，更早的没有列出。');
    expect(visibleText(await renderSfc(LIST_VIEW, listProps()))).not.toContain('只显示最近');
  });

  it('预检 / 恢复这次操作本身的错误单独显示（不占取数错误的位置）', async () => {
    const text = visibleText(await renderSfc(LIST_VIEW, listProps({ actionError: '检查点不存在' })));
    expect(text).toContain('检查点不存在');
    expect(text).toContain('第 2 次运行');                                // 清单照常
    expect(visibleText(await renderSfc(LIST_VIEW, listProps()))).not.toContain('检查点不存在');
  });
});

describe('F08 U 组：ChangeReviewView（真实渲染出的可见文字与按钮状态）', () => {
  it('文本对比：增删行数来自 lineDiff；「写入后」拿不到时退为「改动前 ↔ 当前文件」并写明', async () => {
    const html = await renderSfc(REVIEW_VIEW, reviewProps());
    const text = visibleText(html);
    expect(text).toContain('增 1 行 · 删 1 行');
    expect(text).toContain('改动前 ↔ 改动后');
    expect(text).toContain('src/main.ts');
    expect(text).toContain(describeVerdict(READY));
    expect(buttonDisabled(html, '恢复到这次改动之前')).toBe(false);

    const gone = textDiff({
      after: { exists: true, size: 12, hash: 'b'.repeat(64), source: 'unavailable', form: 'none' },
      current: { exists: true, size: 20, hash: 'c'.repeat(64), source: 'file', form: 'text', text: 'one\ntwo\nthree\nfour\nfive\n' },
      currentIs: 'other',
    });
    const t2 = visibleText(await renderSfc(REVIEW_VIEW, reviewProps({ diff: gone, verdict: { kind: 'conflict', reason: 'modified' }, message: describeVerdict({ kind: 'conflict', reason: 'modified' }) })));
    expect(t2).toContain('改动前 ↔ 当前文件');
    expect(t2).toContain('当前文件已不是这次改动写入的内容');
    expect(t2).toContain('增 2 行 · 删 0 行');
  });

  it('二进制：只显示两侧大小与哈希前 12 位、没有增删行数；过大：写明未做逐行对比；Office：标注不含版式；截断：写明只显示前 256 KB', async () => {
    const bin = textDiff({
      before: { exists: true, size: 2048, hash: 'a1b2c3d4e5f60718' + '0'.repeat(48), source: 'blob', form: 'binary' },
      after: { exists: true, size: 4096, hash: 'f0e1d2c3b4a59687' + '0'.repeat(48), source: 'file', form: 'binary' },
    });
    const t = visibleText(await renderSfc(REVIEW_VIEW, reviewProps({ diff: bin })));
    expect(t).toContain('2.0 KB · a1b2c3d4e5f6');
    expect(t).toContain('4.0 KB · f0e1d2c3b4a5');
    expect(t).not.toMatch(/增 \d+ 行/);

    const big = (p: string): string => Array.from({ length: 2500 }, (_, i) => `${p}${i}`).join('\n');
    const large = textDiff({
      before: { exists: true, size: 20000, hash: 'a'.repeat(64), source: 'blob', form: 'text', text: big('a') },
      after: { exists: true, size: 20000, hash: 'b'.repeat(64), source: 'file', form: 'text', text: big('b') },
    });
    const tl = visibleText(await renderSfc(REVIEW_VIEW, reviewProps({ diff: large })));
    expect(tl).toContain('文件过大，未做逐行对比');
    expect(tl).toContain('2500 行');
    expect(tl).not.toMatch(/增 \d+ 行/);

    const office = textDiff({
      before: { exists: true, size: 9000, hash: 'a'.repeat(64), source: 'blob', form: 'office-text', text: '# 标题\n旧段落' },
      after: { exists: true, size: 9100, hash: 'b'.repeat(64), source: 'file', form: 'office-text', text: '# 标题\n新段落', truncated: true },
    });
    const to = visibleText(await renderSfc(REVIEW_VIEW, reviewProps({ diff: office })));
    expect(to).toContain('按提取出的文字对比，不含版式');
    expect(to).toContain('只显示前 256 KB');
  });

  it('冲突时恢复按钮禁用、另存按钮可用；确认态写明将覆盖 / 将删除哪个文件；恢复之后才有「另存改动后的版本」', async () => {
    const conflict: RestoreVerdict = { kind: 'conflict', reason: 'modified' };
    const html = await renderSfc(REVIEW_VIEW, reviewProps({ verdict: conflict, message: describeVerdict(conflict) }));
    expect(buttonDisabled(html, '恢复到这次改动之前')).toBe(true);
    expect(buttonDisabled(html, '另存改动前的版本')).toBe(false);
    expect(visibleText(html)).not.toContain('另存改动后的版本');
    expect(visibleText(html)).toContain('另存成一个新文件');

    const confirming = visibleText(await renderSfc(REVIEW_VIEW, reviewProps({ confirming: 'single' })));
    expect(confirming).toContain('将覆盖 C:\\work\\src/main.ts');
    expect(confirming).toContain('确认恢复');
    const del = textDiff({ change: change({ id: 'c9', displayPath: 'new.txt', kind: 'create', before: { exists: false }, beforeStored: false }), before: { exists: false, source: 'none', form: 'none' } });
    const delHtml = await renderSfc(REVIEW_VIEW, reviewProps({ diff: del, verdict: { kind: 'ready', action: 'delete' }, confirming: 'single' }));
    expect(visibleText(delHtml)).toContain('将删除 C:\\work\\new.txt');
    expect(buttonDisabled(delHtml, '另存改动前的版本')).toBe(true);

    const restored = textDiff({ change: change({ id: 'c1', displayPath: 'src/main.ts', state: 'restored', afterStored: true }) });
    const result: RestoreReport = { allRestored: true, items: [{ id: 'c1', path: 'C:\\work\\src\\main.ts', outcome: 'restored', message: '已恢复到这次改动之前的内容。恢复前的内容已存进检查点，可以另存。' }] };
    const tr = visibleText(await renderSfc(REVIEW_VIEW, reviewProps({ diff: restored, verdict: { kind: 'unavailable', reason: 'already-restored' }, message: '这次改动已经恢复过了。', result, saved: 'C:\\work\\src\\main.改动前-20261004-120000.ts' })));
    expect(tr).toContain('另存改动后的版本');
    expect(tr).toContain('已恢复到这次改动之前的内容。');
    expect(tr).toContain('已另存到 C:\\work\\src\\main.改动前-20261004-120000.ts');
    expect(tr).toContain('模型不会自动得知这次恢复');
  });

  it('superseded：之后的改动都在本会话——出现「连同之后的 2 次改动一起恢复」；有别的会话的——不出现这个按钮，出现说明与那个会话的标题', async () => {
    const here: RestoreVerdict = { kind: 'conflict', reason: 'superseded', later: [{ id: 'l1', sessionId: 'S1' }, { id: 'l2', sessionId: 'S1' }] };
    const t1 = visibleText(await renderSfc(REVIEW_VIEW, reviewProps({ verdict: here, message: describeVerdict(here, 'S1'), laterHere: ['l1', 'l2'] })));
    expect(t1).toContain('连同之后的 2 次改动一起恢复');
    expect(t1).not.toContain('另一个会话');

    const mixed: RestoreVerdict = { kind: 'conflict', reason: 'superseded', later: [{ id: 'l1', sessionId: 'S1' }, { id: 'l2', sessionId: 'S2' }, { id: 'l3', sessionId: 'S3' }] };
    const t2 = visibleText(await renderSfc(REVIEW_VIEW, reviewProps({
      verdict: mixed, message: describeVerdict(mixed, 'S1'), laterHere: ['l1'],
      laterElsewhere: [{ sessionId: 'S2', count: 1 }, { sessionId: 'S3', count: 1 }], sessionTitles: { S2: '整理季度报表' },
    })));
    expect(t2).not.toContain('连同之后的');
    expect(t2).toContain('这个文件之后被另一个会话改过 2 次，需要先到那个会话恢复：');
    expect(t2).toContain('整理季度报表');
    expect(t2).toContain('已不在列表里的会话');
    expect(t2).toContain('本会话之后还有 1 次改动。');
  });

  it('superseded 的后续改动属于不在会话列表里的会话（F11B：已在其他设备删除、本机留着的副本）：不给跳转按钮——点进去就是把一个已删除的会话当成活的打开——只写明要先在「设备」页恢复它；列表里的会话照常给按钮', async () => {
    const mixed: RestoreVerdict = { kind: 'conflict', reason: 'superseded', later: [{ id: 'l2', sessionId: 'S2' }, { id: 'l3', sessionId: 'S3' }] };
    const html = await renderSfc(REVIEW_VIEW, reviewProps({
      verdict: mixed, message: describeVerdict(mixed, 'S1'),
      laterElsewhere: [{ sessionId: 'S2', count: 1 }, { sessionId: 'S3', count: 1 }], sessionTitles: { S2: '整理季度报表' },
    }));
    const buttons = [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map(m => m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
    expect(buttons).toContain('整理季度报表');
    expect(buttons.filter(b => b.includes('已不在列表里的会话'))).toEqual([]);
    const text = visibleText(html);
    expect(text).toContain('已不在列表里的会话');
    expect(text).toContain('先在「设备」页恢复它');
    // 标题为空的会话仍在列表里：照常是按钮，不被当成已删除
    const untitled = await renderSfc(REVIEW_VIEW, reviewProps({
      verdict: mixed, message: describeVerdict(mixed, 'S1'), laterElsewhere: [{ sessionId: 'S2', count: 2 }], sessionTitles: { S2: '' },
    }));
    expect(visibleText(untitled)).not.toContain('已不在列表里的会话');
    expect([...untitled.matchAll(/<button[^>]*class="[^"]*\blink\b[^"]*"[^>]*>/g)]).toHaveLength(1);
  });

  it('只改了行尾符的改动（CRLF 文件整份写成 LF）：不写「增 0 行 · 删 0 行」，写明两侧只差在行尾并给出两侧大小；只差末尾换行同理', async () => {
    const eolOnly = textDiff({
      before: { exists: true, size: 21, hash: 'a'.repeat(64), source: 'blob', form: 'text', text: 'alpha\r\nbeta\r\ngamma\r\n' },
      after: { exists: true, size: 18, hash: 'b'.repeat(64), source: 'file', form: 'text', text: 'alpha\nbeta\ngamma\n' },
    });
    const t = visibleText(await renderSfc(REVIEW_VIEW, reviewProps({ diff: eolOnly })));
    expect(t).toContain('文字相同，只有行尾符或文件末尾的换行不同。改动前 21 B，改动后 18 B。');
    expect(t).not.toMatch(/增 \d+ 行/);
    const tail = textDiff({
      before: { exists: true, size: 4, hash: 'a'.repeat(64), source: 'blob', form: 'text', text: 'a\nb\n' },
      after: { exists: true, size: 3, hash: 'b'.repeat(64), source: 'file', form: 'text', text: 'a\nb' },
    });
    const tt = visibleText(await renderSfc(REVIEW_VIEW, reviewProps({ diff: tail })));
    expect(tt).toContain('只有行尾符或文件末尾的换行不同。改动前 4 B，改动后 3 B。');
    expect(tt).not.toMatch(/增 \d+ 行/);
    // 新建了一个空文件：同样没有一行可列，说的是「新建、没有文字」，不是「增 0 行 · 删 0 行」
    const empty = textDiff({
      change: change({ id: 'c9', displayPath: 'empty.txt', kind: 'create', before: { exists: false }, beforeStored: false }),
      before: { exists: false, source: 'none', form: 'none' },
      after: { exists: true, size: 0, hash: 'e'.repeat(64), source: 'file', form: 'text', text: '' },
    });
    const te = visibleText(await renderSfc(REVIEW_VIEW, reviewProps({ diff: empty, verdict: { kind: 'ready', action: 'delete' } })));
    expect(te).toContain('改动前这个文件不存在，改动后是一个没有文字的文件。');
    expect(te).not.toMatch(/增 \d+ 行/);
  });

  it('文字与行尾一起变：增删行数照常，另写明还有几行只是行尾不同；Office 提取出的文字没变时说差别在版式，不说行尾', async () => {
    const mixed = textDiff({
      before: { exists: true, size: 9, hash: 'a'.repeat(64), source: 'blob', form: 'text', text: 'a\r\nb\r\nc\r\n' },
      after: { exists: true, size: 6, hash: 'b'.repeat(64), source: 'file', form: 'text', text: 'a\nB\nc\n' },
    });
    const t = visibleText(await renderSfc(REVIEW_VIEW, reviewProps({ diff: mixed })));
    expect(t).toContain('增 1 行 · 删 1 行 · 另有 2 行文字相同、只是行尾符或文件末尾的换行不同');
    // 普通的文字改动不出这半句
    expect(visibleText(await renderSfc(REVIEW_VIEW, reviewProps()))).not.toContain('只是行尾符');
    const office = textDiff({
      before: { exists: true, size: 9000, hash: 'a'.repeat(64), source: 'blob', form: 'office-text', text: '# 标题\n正文' },
      after: { exists: true, size: 9100, hash: 'b'.repeat(64), source: 'file', form: 'office-text', text: '# 标题\n正文' },
    });
    const to = visibleText(await renderSfc(REVIEW_VIEW, reviewProps({ diff: office })));
    expect(to).toContain('提取出的文字相同，差别在版式或文档的其它部分。改动前 8.8 KB，改动后 8.9 KB。');
    expect(to).not.toMatch(/增 \d+ 行/);
    expect(to).not.toContain('行尾');
  });

  it('「查看当前文件」：文件在工作区内且现在还在时才有；工作区外（显示的是绝对路径）或文件已不在时没有', async () => {
    expect(visibleText(await renderSfc(REVIEW_VIEW, reviewProps()))).toContain('查看当前文件');
    const outside = textDiff({ change: change({ id: 'c1', displayPath: 'D:\\elsewhere\\a.txt', path: 'D:\\elsewhere\\a.txt' }) });
    expect(visibleText(await renderSfc(REVIEW_VIEW, reviewProps({ diff: outside })))).not.toContain('查看当前文件');
    const gone = textDiff({ current: { exists: false, source: 'none', form: 'none' }, currentIs: 'missing' });
    expect(visibleText(await renderSfc(REVIEW_VIEW, reviewProps({ diff: gone })))).not.toContain('查看当前文件');
    expect(visibleText(await renderSfc(REVIEW_VIEW, reviewProps({ diff: null, verdict: null, message: '' })))).not.toContain('查看当前文件');
  });

  it('恢复 / 另存这次操作本身的错误单独显示', async () => {
    const t = visibleText(await renderSfc(REVIEW_VIEW, reviewProps({ actionError: '另存失败：ENOSPC: no space left on device' })));
    expect(t).toContain('另存失败：ENOSPC: no space left on device');
    expect(t).toContain('增 1 行 · 删 1 行');                             // 对比照常
  });

  it('底部固定有范围说明', async () => {
    expect(visibleText(await renderSfc(REVIEW_VIEW, reviewProps()))).toContain(CHECKPOINT_SCOPE_NOTE);
    expect(visibleText(await renderSfc(REVIEW_VIEW, reviewProps({ diff: null, verdict: null, message: '' })))).toContain(CHECKPOINT_SCOPE_NOTE);
  });
});

describe('F08 U 组：外壳（取了什么、发了什么）', () => {
  type ListB = {
    list: { value: ChangeList | null }; error: { value: string }; actionError: { value: string }; precheck: { value: RestorePrecheck[] | null }; report: { value: RestoreReport | null };
    expandedRunId: { value: string | null }; quotaError: { value: string }; quotaEditing: { value: boolean }; legacy: { value: { path: string }[] };
    inspectRun(id: string): Promise<void>; restoreRun(): Promise<void>; setQuota(n: number): Promise<void>; collapse(): void;
  };
  type ReviewB = {
    diff: { value: ChangeDiff | null }; pre: { value: RestorePrecheck | null }; confirming: { value: string | null }; result: { value: RestoreReport | null }; saved: { value: string };
    error: { value: string }; actionError: { value: string };
    onRestore(): void; onRestoreWithLater(): void; onSaveCopy(w: 'before' | 'after'): Promise<void>; gotoSession(id: string): void; openCurrent(path: string): void;
  };
  const callsOf = (method: string): unknown[] => call.mock.calls.filter(c => c[0] === method).map(c => c[1]);

  it('ChangeList：挂载时取 checkpoints.list；checkpoints.changed 触发重取，卸载后摘掉订阅；被拒时 error 有值且不抛', async () => {
    const chat = useChat(); chat.activeId = 'S1';
    call.mockImplementation(async (m: string) => (m === 'checkpoints.list' ? twoRuns() : undefined));
    const scope = effectScope();
    const run = await runSetup<ListB>(LIST, { selected: null }, scope);
    run.mount();
    await flush();
    expect(callsOf('checkpoints.list')).toEqual([{ sessionId: 'S1' }]);
    expect(run.bindings.list.value?.groups).toHaveLength(2);
    expect(on.mock.calls.map(c => c[0])).toEqual(['checkpoints.changed']);
    const handler = on.mock.calls[0][1] as (p: unknown) => void;
    handler({ sessionId: 'S1' });
    await flush();
    expect(callsOf('checkpoints.list')).toHaveLength(2);
    handler({ sessionId: 'OTHER' });        // 别的会话的提示不重取
    await flush();
    expect(callsOf('checkpoints.list')).toHaveLength(2);
    // 被拒（远程连接）：error 有值、不抛
    call.mockImplementation(async () => { throw new Error('文件检查点只能在运行 DeskMinis 引擎的这台电脑上查看和恢复'); });
    handler({ sessionId: 'S1' });
    await flush();
    expect(run.bindings.error.value).toContain('只能在运行 DeskMinis 引擎的这台电脑上');
    expect(run.bindings.list.value).toBeNull();
    run.unmount();
    expect(off.mock.calls).toEqual([['checkpoints.changed', handler]]);
  });

  it('F06：重连之后的整体刷新（chat.refreshTick 加一）让 ChangeList 重取清单、ChangeReview 重取对比与预检——丢在断线里的 checkpoints.changed 不会补发', async () => {
    const chat = useChat(); chat.activeId = 'S1';
    call.mockImplementation(async (m: string) => (m === 'checkpoints.list' ? twoRuns() : m === 'checkpoints.inspect' ? [] : undefined));
    const list = await runSetup<ListB>(LIST, { selected: null }, effectScope());
    list.mount();
    await flush();
    expect(callsOf('checkpoints.list')).toEqual([{ sessionId: 'S1' }]);
    const review = await runSetup<ReviewB>(REVIEW, { id: 'c1' }, effectScope());
    review.mount();
    await flush();
    expect([callsOf('checkpoints.diff'), callsOf('checkpoints.inspect')]).toEqual([[{ sessionId: 'S1', id: 'c1' }], [{ sessionId: 'S1', ids: ['c1'] }]]);
    expect(typeof chat.refreshTick).toBe('number');
    chat.refreshTick += 1;
    await flush();
    expect(callsOf('checkpoints.list')).toEqual([{ sessionId: 'S1' }, { sessionId: 'S1' }]);
    expect([callsOf('checkpoints.diff').length, callsOf('checkpoints.inspect').length]).toEqual([2, 2]);
    list.unmount(); review.unmount();
  });

  it('ChangeList：「恢复这次运行」先发 inspect（那一组的全部 id），确认后才发 restore（发的是按预检算出来的那几条、带 confirm；被用户改过的不发）；改容量越界时错误原样留着', async () => {
    const chat = useChat(); chat.activeId = 'S1';
    const precheck: RestorePrecheck[] = [
      { id: 'c2', path: 'p2', verdict: { kind: 'conflict', reason: 'modified' }, message: 'm' },
      { id: 'c1', path: 'p1', verdict: READY, message: 'r' },
    ];
    const report: RestoreReport = { allRestored: true, items: [{ id: 'c1', path: 'p1', outcome: 'restored', message: 'ok' }] };
    call.mockImplementation(async (m: string) => {
      if (m === 'checkpoints.list') return twoRuns();
      if (m === 'checkpoints.inspect') return precheck;
      if (m === 'checkpoints.restore') return report;
      if (m === 'checkpoints.setQuota') throw new Error('检查点上限必须在 128 MB 到 64 GB 之间');
      return undefined;
    });
    const run = await runSetup<ListB>(LIST, { selected: null }, effectScope());
    run.mount();
    await flush();
    await run.bindings.inspectRun('RUN-1');
    expect(callsOf('checkpoints.inspect')).toEqual([{ sessionId: 'S1', ids: ['c2', 'c1'] }]);
    expect(callsOf('checkpoints.restore')).toEqual([]);          // 预检不等于恢复
    expect(run.bindings.expandedRunId.value).toBe('RUN-1');
    expect(run.bindings.precheck.value).toEqual(precheck);
    await run.bindings.restoreRun();
    expect(callsOf('checkpoints.restore')).toEqual([{ sessionId: 'S1', ids: ['c1'], confirm: true }]);
    expect(run.bindings.report.value).toEqual(report);
    await run.bindings.setQuota(1024 * 1024);
    expect(run.bindings.quotaError.value).toBe('检查点上限必须在 128 MB 到 64 GB 之间');
    run.unmount();
  });

  it('ChangeList：同一次运行里同一个文件改了两次——确认后一次发出两条 id（最新的那条就绪、较早的那条 superseded 且后续就是它），不是只发就绪的那一条', async () => {
    const chat = useChat(); chat.activeId = 'S1';
    const list = twoRuns();
    list.groups[1].changes.unshift(change({ id: 'c4', displayPath: 'src/main.ts', seq: 4 }));   // 第 1 次运行：c4（新）、c2、c1（旧），c4 与 c1 是同一个文件
    const sup: RestoreVerdict = { kind: 'conflict', reason: 'superseded', later: [{ id: 'c4', sessionId: 'S1' }] };
    const precheck: RestorePrecheck[] = [
      { id: 'c4', path: 'p-main', verdict: READY, message: 'r' },
      { id: 'c2', path: 'p-docx', verdict: { kind: 'conflict', reason: 'modified' }, message: 'm' },
      { id: 'c1', path: 'p-main', verdict: sup, message: describeVerdict(sup, 'S1') },
    ];
    call.mockImplementation(async (m: string) => {
      if (m === 'checkpoints.list') return list;
      if (m === 'checkpoints.inspect') return precheck;
      if (m === 'checkpoints.restore') return { allRestored: true, items: [] };
      return undefined;
    });
    const run = await runSetup<ListB>(LIST, { selected: null }, effectScope());
    run.mount();
    await flush();
    await run.bindings.inspectRun('RUN-1');
    expect(callsOf('checkpoints.inspect')).toEqual([{ sessionId: 'S1', ids: ['c4', 'c2', 'c1'] }]);
    await run.bindings.restoreRun();
    expect(callsOf('checkpoints.restore')).toEqual([{ sessionId: 'S1', ids: ['c4', 'c1'], confirm: true }]);
    run.unmount();
  });

  it('ChangeList：恢复这次调用整体被拒时，错误在随后的重取成功之后仍然留着；收起或下一次操作才清。预检被拒同理', async () => {
    const chat = useChat(); chat.activeId = 'S1';
    let restoreFails = true; let inspectFails = false;
    call.mockImplementation(async (m: string) => {
      if (m === 'checkpoints.list') return twoRuns();
      if (m === 'checkpoints.inspect') { if (inspectFails) throw new Error('一次最多处理 200 条检查点'); return [{ id: 'c1', path: 'p1', verdict: READY, message: 'r' }]; }
      if (m === 'checkpoints.restore') { if (restoreFails) throw new Error('检查点不存在'); return { allRestored: true, items: [{ id: 'c1', path: 'p1', outcome: 'restored', message: 'ok' }] }; }
      return undefined;
    });
    const run = await runSetup<ListB>(LIST, { selected: null }, effectScope());
    run.mount();
    await flush();
    await run.bindings.inspectRun('RUN-1');
    const listsBefore = callsOf('checkpoints.list').length;
    await run.bindings.restoreRun();
    await flush();                                              // 恢复之后的那一次重取已经成功返回
    expect(callsOf('checkpoints.list').length).toBe(listsBefore + 1);
    expect(run.bindings.error.value).toBe('');                  // 取数没有错
    expect(run.bindings.actionError.value).toBe('检查点不存在');  // 操作的错还在：不是闪一下就没了
    expect(run.bindings.report.value).toBeNull();
    // checkpoints.changed 再触发一次重取：仍然留着
    (on.mock.calls[0][1] as (p: unknown) => void)({ sessionId: 'S1' });
    await flush();
    expect(run.bindings.actionError.value).toBe('检查点不存在');
    // 下一次操作成功：清掉
    restoreFails = false;
    await run.bindings.restoreRun();
    expect(run.bindings.actionError.value).toBe('');
    expect(run.bindings.report.value?.allRestored).toBe(true);
    // 预检被拒：面板收起，错误留着；用户收起（collapse）才清
    inspectFails = true;
    await run.bindings.inspectRun('RUN-2');
    await flush();
    expect(run.bindings.expandedRunId.value).toBeNull();
    expect(run.bindings.actionError.value).toBe('一次最多处理 200 条检查点');
    run.bindings.collapse();
    expect(run.bindings.actionError.value).toBe('');
    run.unmount();
  });

  it('ChangeList：「没有检查点的改动」不列引擎标为已覆盖的调用（含没有改变文件的写入）与结果还没到的调用', async () => {
    const chat = useChat(); chat.activeId = 'S1';
    const write = (id: string, path: string) => ({ type: 'toolUse', value: { toolUseId: id, name: 'file_write', input: JSON.stringify({ path, content: 'x' }) } });
    const ok = (id: string) => ({ type: 'toolResult', value: { toolUseId: id, success: true } });
    (chat as unknown as { messages: unknown[] }).messages = [
      { id: 'm1', role: 'user', parts: [{ type: 'text', value: '开始' }] },
      { id: 'm2', role: 'assistant', parts: [write('tu-old', 'old.txt'), write('tu-c1', 'has-checkpoint.txt'), write('tu-same', 'same.txt')] },
      { id: 'm3', role: 'user', parts: [ok('tu-old'), ok('tu-c1'), ok('tu-same')] },
    ];
    (chat as unknown as { toolCards: unknown[] }).toolCards = [
      { toolUseId: 'tu-waiting', name: 'file_write', input: JSON.stringify({ path: 'waiting.txt', content: 'y' }) },   // 还在等审批
    ];
    const list = twoRuns();
    // 引擎给的已覆盖集合：有检查点的（tu-c1…），加上由带检查点的引擎执行、内容相同所以没有记录的 tu-same
    list.coveredToolUseIds = ['tu-c1', 'tu-c2', 'tu-c3', 'tu-same'];
    call.mockImplementation(async (m: string) => (m === 'checkpoints.list' ? list : undefined));
    const run = await runSetup<ListB>(LIST, { selected: null }, effectScope());
    run.mount();
    await flush();
    expect(run.bindings.legacy.value.map(a => a.path)).toEqual(['old.txt']);
    // 这一轮刚跑完的一步（实时卡片上已有结果，上一次取到的已覆盖名单还不认识它）：清单取得到时不列——
    // 它是这台引擎执行的，写成了就有检查点，没有检查点的只可能是内容没变
    (chat as unknown as { toolCards: unknown[] }).toolCards = [
      { toolUseId: 'tu-just-done', name: 'file_write', input: JSON.stringify({ path: 'just-done.txt', content: 'z' }), success: true },
    ];
    await flush();
    expect(run.bindings.legacy.value.map(a => a.path)).toEqual(['old.txt']);
    // 清单取不到（远程连接）：没有别的来源，实时卡片上已有结果的照常列，结果还没到的仍不列
    call.mockImplementation(async () => { throw new Error('文件检查点只能在运行 DeskMinis 引擎的这台电脑上查看和恢复'); });
    (chat as unknown as { toolCards: unknown[] }).toolCards = [
      { toolUseId: 'tu-just-done', name: 'file_write', input: JSON.stringify({ path: 'just-done.txt', content: 'z' }), success: true },
      { toolUseId: 'tu-waiting', name: 'file_write', input: JSON.stringify({ path: 'waiting.txt', content: 'y' }) },
    ];
    (on.mock.calls[0][1] as (p: unknown) => void)({ sessionId: 'S1' });
    await flush();
    expect(run.bindings.list.value).toBeNull();
    expect(run.bindings.legacy.value.map(a => a.path).sort()).toEqual(['has-checkpoint.txt', 'just-done.txt', 'old.txt', 'same.txt']);
    run.unmount();
  });

  it('ChangeReview：挂载时取 diff 与 inspect；恢复要点两次才发 restore；另存带 confirm', async () => {
    const chat = useChat(); chat.activeId = 'S1';
    const pre: RestorePrecheck = { id: 'c1', path: 'p1', verdict: READY, message: describeVerdict(READY) };
    call.mockImplementation(async (m: string) => {
      if (m === 'checkpoints.diff') return textDiff();
      if (m === 'checkpoints.inspect') return [pre];
      if (m === 'checkpoints.restore') return { allRestored: true, items: [{ id: 'c1', path: 'p1', outcome: 'restored', message: 'ok' }] };
      if (m === 'checkpoints.saveCopy') return { path: 'C:\\work\\copy.txt' };
      return undefined;
    });
    const run = await runSetup<ReviewB>(REVIEW, { id: 'c1' }, effectScope());
    run.mount();
    await flush();
    expect(callsOf('checkpoints.diff')).toEqual([{ sessionId: 'S1', id: 'c1' }]);
    expect(callsOf('checkpoints.inspect')).toEqual([{ sessionId: 'S1', ids: ['c1'] }]);
    expect(run.bindings.diff.value?.change.id).toBe('c1');
    run.bindings.onRestore();
    await flush();
    expect(callsOf('checkpoints.restore')).toEqual([]);          // 第一次点只进确认态
    expect(run.bindings.confirming.value).toBe('single');
    run.bindings.onRestore();
    await flush();
    expect(callsOf('checkpoints.restore')).toEqual([{ sessionId: 'S1', ids: ['c1'], confirm: true }]);
    expect(run.bindings.result.value?.items[0].outcome).toBe('restored');
    expect(run.bindings.confirming.value).toBeNull();
    await run.bindings.onSaveCopy('before');
    expect(callsOf('checkpoints.saveCopy')).toEqual([{ sessionId: 'S1', id: 'c1', which: 'before', confirm: true }]);
    expect(run.bindings.saved.value).toBe('C:\\work\\copy.txt');
    run.unmount();
    expect(off.mock.calls.map(c => c[0])).toEqual(['checkpoints.changed']);
  });

  it('ChangeReview：不就绪时点恢复不发请求；之后的改动都在本会话——「一起恢复」发出本条加 later；有别的会话的——不调 restore，跳转调 chat.open', async () => {
    const chat = useChat(); chat.activeId = 'S1';
    const opened: string[] = [];
    (chat as unknown as { open(id: string): Promise<void> }).open = async (id: string) => { opened.push(id); };
    let verdict: RestoreVerdict = { kind: 'conflict', reason: 'superseded', later: [{ id: 'l1', sessionId: 'S1' }, { id: 'l2', sessionId: 'S1' }] };
    call.mockImplementation(async (m: string) => {
      if (m === 'checkpoints.diff') return textDiff();
      if (m === 'checkpoints.inspect') return [{ id: 'c1', path: 'p1', verdict, message: 'x' }];
      if (m === 'checkpoints.restore') return { allRestored: true, items: [] };
      return undefined;
    });
    const run = await runSetup<ReviewB>(REVIEW, { id: 'c1' }, effectScope());
    run.mount();
    await flush();
    run.bindings.onRestore(); run.bindings.onRestore();
    await flush();
    expect(callsOf('checkpoints.restore')).toEqual([]);          // superseded 不是就绪：单条恢复不发
    run.bindings.onRestoreWithLater();
    await flush();
    expect(callsOf('checkpoints.restore')).toEqual([]);          // 第一次点只进确认态
    run.bindings.onRestoreWithLater();
    await flush();
    expect(callsOf('checkpoints.restore')).toEqual([{ sessionId: 'S1', ids: ['c1', 'l1', 'l2'], confirm: true }]);
    run.unmount();

    // 跨会话：不发请求
    call.mockClear();
    verdict = { kind: 'conflict', reason: 'superseded', later: [{ id: 'l1', sessionId: 'S1' }, { id: 'l2', sessionId: 'S2' }] };
    const run2 = await runSetup<ReviewB>(REVIEW, { id: 'c1' }, effectScope());
    run2.mount();
    await flush();
    run2.bindings.onRestoreWithLater(); run2.bindings.onRestoreWithLater(); run2.bindings.onRestoreWithLater();
    await flush();
    expect(callsOf('checkpoints.restore')).toEqual([]);
    expect(run2.bindings.confirming.value).toBeNull();
    run2.bindings.gotoSession('S2');
    expect(opened).toEqual(['S2']);
    run2.unmount();
  });

  it('ChangeReview：恢复 / 另存整体被拒时，错误在随后的重取成功之后仍然留着，下一次操作才清；「查看当前文件」把路径交给外壳', async () => {
    const chat = useChat(); chat.activeId = 'S1';
    const pre: RestorePrecheck = { id: 'c1', path: 'p1', verdict: READY, message: describeVerdict(READY) };
    let saveFails = true;
    call.mockImplementation(async (m: string) => {
      if (m === 'checkpoints.diff') return textDiff();
      if (m === 'checkpoints.inspect') return [pre];
      if (m === 'checkpoints.restore') throw new Error('检查点不存在');
      if (m === 'checkpoints.saveCopy') { if (saveFails) throw new Error('另存失败：ENOSPC'); return { path: 'C:\\work\\copy.txt' }; }
      return undefined;
    });
    const emitted: unknown[][] = [];
    const run = await runSetup<ReviewB>(REVIEW, { id: 'c1' }, effectScope(), { emit: (...a) => { emitted.push(a); } });
    run.mount();
    await flush();
    run.bindings.onRestore(); run.bindings.onRestore();
    await flush();                                              // 恢复之后的那一次重取（diff + inspect）已经成功返回
    expect(callsOf('checkpoints.restore')).toHaveLength(1);
    expect(callsOf('checkpoints.diff')).toHaveLength(2);
    expect(run.bindings.error.value).toBe('');
    expect(run.bindings.actionError.value).toBe('检查点不存在');
    expect(run.bindings.result.value).toBeNull();
    // 另存失败：换成这一次的错；checkpoints.changed 触发的重取不清它
    await run.bindings.onSaveCopy('before');
    expect(run.bindings.actionError.value).toBe('另存失败：ENOSPC');
    (on.mock.calls[0][1] as (p: unknown) => void)({ sessionId: 'S1' });
    await flush();
    expect(run.bindings.actionError.value).toBe('另存失败：ENOSPC');
    expect(run.bindings.saved.value).toBe('');
    // 下一次操作成功：清掉
    saveFails = false;
    await run.bindings.onSaveCopy('before');
    expect(run.bindings.actionError.value).toBe('');
    expect(run.bindings.saved.value).toBe('C:\\work\\copy.txt');
    run.bindings.openCurrent('src/main.ts');
    expect(emitted).toEqual([['open', 'src/main.ts']]);
    run.unmount();
  });
});

describe('F08 U 组：AppShell——审阅面板与标签栏', () => {
  type AppB = Record<string, unknown> & {
    previewPath: { value: string | null }; reviewId: { value: string | null }; openDocs: { value: string[] };
    openDoc(p: string): void; closeDoc(p: string): void;
  };
  const tpl = sfcBlocks(readFileSync(APP, 'utf8').replace(/\r\n/g, '\n'), 'AppShell.vue').template;
  /** 标签栏在 AppShell 这边绑的「点标签」处理函数与「当前标签」的绑定名（模板里现取，不写死）。 */
  const tabBar = /<TabBar\b[^>]*>/.exec(tpl)?.[0] ?? '';
  const pickName = /@pick="(\w+)"/.exec(tabBar)?.[1] ?? '';
  const activeName = /:active="(\w+)"/.exec(tabBar)?.[1] ?? '';

  async function shell(): Promise<{ b: AppB; pick: (p: string | null) => void; active: () => unknown; unmount: () => void }> {
    (globalThis as { window?: unknown }).window = { deskminis: { onMenuOpenSettings: () => () => {}, onMenuToggleRight: () => () => {} } };
    const chat = useChat();
    chat.init = async () => {};
    const run = await runSetup<AppB>(APP, {}, effectScope());
    return {
      b: run.bindings, pick: run.bindings[pickName] as (p: string | null) => void,
      active: () => (run.bindings[activeName] as { value: unknown }).value,
      unmount: () => { run.unmount(); delete (globalThis as { window?: unknown }).window; },
    };
  }

  it('审阅面板开着时点文档标签：切到那个文档的预览，审阅面板关掉（以前只换了预览路径，舞台上还是审阅面板）', async () => {
    expect(pickName, '标签栏的 @pick 要绑一个具名函数').not.toBe('');
    expect(activeName, '标签栏的 :active 要绑一个具名的值').not.toBe('');
    // 模板里审阅面板排在预览前面：reviewId 不清，预览就出不来
    expect(tpl.indexOf('<ChangeReview v-if="reviewId"')).toBeGreaterThan(0);
    expect(tpl.indexOf('<ChangeReview v-if="reviewId"')).toBeLessThan(tpl.indexOf('<PreviewPane v-else-if="previewPath"'));
    const { b, pick, unmount } = await shell();
    b.openDoc('a.md'); b.openDoc('b.md');
    b.reviewId.value = 'CP-1';                                  // 从「改动」页点开一条检查点
    expect(b.previewPath.value).toBe('b.md');
    pick('a.md');
    expect(b.reviewId.value).toBeNull();
    expect(b.previewPath.value).toBe('a.md');
    // 点会话标签（回到纯对话）同样关掉审阅面板
    b.reviewId.value = 'CP-1';
    pick(null);
    expect([b.reviewId.value, b.previewPath.value]).toEqual([null, null]);
    unmount();
  });

  it('审阅面板开着时标签栏一个都不标成当前；关掉之后照旧标预览着的那个；关标签不动审阅面板；「查看当前文件」走 openDoc', async () => {
    const { b, active, unmount } = await shell();
    b.openDoc('a.md');
    expect(active()).toBe('a.md');
    b.reviewId.value = 'CP-1';
    expect(active()).toBeUndefined();                           // 既不是 'a.md' 也不是 null（会话标签）
    b.closeDoc('a.md');
    expect(b.reviewId.value).toBe('CP-1');
    b.reviewId.value = null;
    expect(active()).toBeNull();
    // 审阅面板的 open 事件接在 openDoc 上：打开预览并关掉审阅面板
    expect(/<ChangeReview\b[^>]*@open="openDoc"/.test(tpl)).toBe(true);
    b.reviewId.value = 'CP-2';
    b.openDoc('src/main.ts');
    expect([b.reviewId.value, b.previewPath.value]).toEqual([null, 'src/main.ts']);
    unmount();
  });
});
