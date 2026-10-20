import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, reactive, type VNode } from 'vue';
import { join } from 'node:path';
const probe = vi.hoisted(() => ({ call: vi.fn(), on: vi.fn(), handlers: new Map<string, (p: any) => unknown>(), lost: vi.fn(), connect: vi.fn(async () => {}) }));
vi.mock('../src/renderer/src/rpc', () => ({ rpc: { call: probe.call, on: probe.on, onLost: probe.lost, connect: probe.connect } }));
import { initStore, resetStoreRpc } from './renderer-store-fixture';
import { runSetup } from './sfc-setup';
import { diffRows, foldLines, readDiffLayout } from '../src/renderer/src/lib/diff/view';
import { lineDiff } from '../src/renderer/src/lib/changes/model';
import type { DiffLine } from '../src/renderer/src/lib/diff/lcs';
const UI = join(__dirname, '../src/renderer/src/ui');
const all = (v: any): VNode[] => Array.isArray(v) ? v.flatMap(all) : v && typeof v === 'object' && 'type' in v ? [v, ...all(v.children)] : [];
const cls = (v: VNode, c: string) => String(v.props?.class ?? '').split(' ').includes(c);
const disposers: (() => void)[] = [];
async function view(name: string, props: Record<string, unknown>) {
  const s = await runSetup<(ctx: object, cache: unknown[]) => VNode>(join(UI, name + '.vue'), props, effectScope(), { inlineTemplate: true });
  disposers.push(s.unmount); return { s, render: () => all(s.bindings({}, [])) };
}
const ctx = (n: number, offset = 0): DiffLine[] => Array.from({ length: n }, (_, i) => ({ type: 'ctx', text: 'same ' + (i + offset + 1), oldNo: i + offset + 1, newNo: i + offset + 1 }));
const diffProps = (lines: DiffLine[]) => ({ lines, addCount: lines.filter(l => l.type === 'add').length, delCount: lines.filter(l => l.type === 'del').length, lineNumbers: true, path: 'src/a.ts' });
beforeEach(() => { resetStoreRpc(probe); vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }); });
afterEach(() => { disposers.splice(0).reverse().forEach(f => f()); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('N25 folding keeps original lines', () => {
  it('three hidden lines do not fold; four fold with exactly three at either side', () => {
    expect(foldLines(ctx(9), new Set())).toEqual(ctx(9));
    expect(foldLines(ctx(10), new Set())).toEqual([...ctx(3), { type: 'fold', start: 3, count: 4 }, ...ctx(3, 7)]);
  });
  it('full width native button expands original numbers, changes stay visible and content resets expansion', async () => {
    const p = reactive(diffProps([...ctx(20), { type: 'del', text: 'old', oldNo: 21 }, { type: 'add', text: 'new', newNo: 21 }]));
    const v = await view('UiDiff', p);
    const folds = () => v.render().filter(n => n.type === 'button');
    expect(folds().map(n => n.children)).toEqual(['展开 14 行未改动']);
    expect(folds()[0].props?.type).toBe('button');
    expect(v.render().filter(n => cls(n, 'dtext')).map(n => n.children)).toEqual(['same 1', 'same 2', 'same 3', 'same 18', 'same 19', 'same 20', 'old', 'new']);
    expect(v.render().filter(n => cls(n, 'tnum') && !cls(n, 'no')).map(n => n.children)).toEqual(['+1', '-1']);
    folds()[0].props!.onClick();
    expect(folds()).toEqual([]);
    expect(v.render().filter(n => cls(n, 'no')).map(n => n.children)).toEqual([...ctx(20).flatMap(l => [String(l.oldNo), String(l.newNo)]), '21', '', '', '21']);
    p.lines = p.lines.map(l => ({ ...l, text: l.text + ' changed' }));
    expect(folds().map(n => n.children)).toEqual(['展开 14 行未改动']);
  });
  it('review preserves twenty-line middle and prefixes/suffixes, with contiguous numbers after expansion', async () => {
    const old = [...ctx(20).map(l => l.text), 'old A', ...ctx(20, 21).map(l => l.text), 'old B', ...ctx(20, 42).map(l => l.text)];
    const next = old.map(s => s.replace('old', 'new'));
    const d = lineDiff(old.join('\n'), next.join('\n')); if (d.tooLarge) throw Error('fixture');
    expect(d.lines.filter(l => l.type === 'ctx')).toHaveLength(60);
    expect(d.lines.filter(l => l.type === 'ctx').map(l => [l.oldNo, l.newNo])).toEqual([...ctx(20), ...ctx(20, 21), ...ctx(20, 42)].map(l => [l.oldNo, l.newNo]));
    const v = await view('UiDiff', diffProps(d.lines));
    expect(v.render().filter(n => n.type === 'button').map(n => n.children)).toEqual(Array(3).fill('展开 14 行未改动'));
    for (const b of v.render().filter(n => n.type === 'button')) b.props!.onClick();
    expect(v.render().filter(n => cls(n, 'dtext')).map(n => n.children)).toEqual(d.lines.map(l => l.text));
    expect(v.render().filter(n => cls(n, 'no')).map(n => n.children)).toEqual(d.lines.flatMap(l => [String(l.oldNo ?? ''), String(l.newNo ?? '')]));
  });
  it('permission receives full-file diff and folding; step preview stays unified', async () => {
    await initStore(probe);
    const before = ctx(20).map(l => l.text).join('\n') + '\nold';
    const perm = await view('PermCard', { perm: { requestId: 'R', kind: 'file-write', detail: 'a.ts', toolTitle: '', preview: { oldText: before, newText: before.replace('old', 'new') } } });
    const child = perm.render().find(n => (n.type as any)?.name === './UiDiff.vue')!;
    expect(child.props?.lines).toHaveLength(22); expect(child.props?.split).toBeUndefined();
    const d = await view('UiDiff', { lines: child.props!.lines, addCount: 1, delCount: 1 });
    expect(d.render().some(n => n.children === '展开 14 行未改动')).toBe(true);
    const s = await view('StepGroup', { steps: [{ name: 'file_edit', status: 'ok', title: '', input: JSON.stringify({ path: 'a.ts', old_string: before, new_string: before.replace('old', 'new') }) }] });
    s.render().find(n => n.type === 'button')!.props!.onClick();
    expect(s.render().find(n => (n.type as any)?.name === './UiDiff.vue')?.props?.split).toBeUndefined();
  });
});

describe('N25 split rows and review preference', () => {
  const lines: DiffLine[] = [...ctx(1), { type: 'del', text: 'd1', oldNo: 2 }, { type: 'del', text: 'd2', oldNo: 3 }, ...[2, 3, 4].map((n): DiffLine => ({ type: 'add', text: 'a' + (n - 1), newNo: n })), { type: 'ctx', text: 'end', oldNo: 4, newNo: 5 }];
  it('pairs ith deletion with ith addition and blank last left, context on both sides', async () => {
    expect(diffRows(lines, true)).toEqual([{ kind: 'split', old: lines[0], next: lines[0] }, { kind: 'split', old: lines[1], next: lines[3] }, { kind: 'split', old: lines[2], next: lines[4] }, { kind: 'split', old: undefined, next: lines[5] }, { kind: 'split', old: lines[6], next: lines[6] }]);
    const v = await view('UiDiff', { ...diffProps(lines), split: true });
    expect(v.render().filter(n => cls(n, 'srow'))).toHaveLength(5);
    expect(v.render().filter(n => cls(n, 'empty'))).toHaveLength(1);
    expect(v.render().filter(n => cls(n, 'no')).map(n => n.children)).toEqual(['1', '1', '2', '2', '3', '3', '4', '4', '5']);
    const folded = await view('UiDiff', { ...diffProps(ctx(20)), split: true });
    expect(folded.render().filter(n => n.type === 'button')).toHaveLength(1);
    expect(folded.render().filter(n => cls(n, 'srow'))).toHaveLength(6);
  });
  for (const stored of [null, 'garbage', 'split', 'unified', 'throws']) it('review persists layout, validates storage and forces unified below560: ' + stored, async () => {
    const storage = { getItem: vi.fn(() => { if (stored === 'throws') throw Error('blocked'); return stored; }), setItem: vi.fn(() => { if (stored === 'throws') throw Error('blocked'); }) };
    vi.stubGlobal('localStorage', storage); expect(readDiffLayout()).toBe(stored === 'split' ? 'split' : 'unified');
    let resize!: () => void, width = 560; const disconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', class { constructor(cb: () => void) { resize = cb; } observe() {} disconnect = disconnect; });
    const text = ctx(20).map(l => l.text).join('\n');
    const v = await view('ChangeReviewView', { diff: { change: { displayPath: 'a.ts' }, before: { exists: true, source: 'blob', form: 'text', text: text + '\nold' }, after: { exists: true, source: 'file', form: 'text', text: text + '\nnew' } }, verdict: null, message: '', laterHere: [], laterElsewhere: [], sessionTitles: {}, confirming: null, result: null, saved: '', busy: false, error: '' });
    const root = v.render()[0]; (root.ref as any).r.value = { getBoundingClientRect: () => ({ width }) }; await nextTick();
    const child = () => v.render().find(n => (n.type as any)?.name === './UiDiff.vue')!;
    const buttons = () => v.render().filter(n => n.props?.['aria-pressed'] !== undefined);
    expect(child().props!.split).toBe(stored === 'split');
    buttons()[1].props!.onClick(); expect(child().props!.split).toBe(true); expect(storage.setItem).toHaveBeenCalledWith('deskminis.diffLayout', 'split');
    width = 559; resize(); expect(child().props!.split).toBe(false);
    expect(buttons().map(n => [n.props!.disabled, n.props!.title])).toEqual(Array(2).fill([true, '面板太窄：拖宽分隔条或放大窗口']));
    buttons()[0].props!.onClick(); width = 700; resize(); expect(child().props!.split).toBe(true);
    buttons()[0].props!.onClick(); expect(child().props!.split).toBe(false);
    v.s.unmount(); disposers.pop(); expect(disconnect).toHaveBeenCalled();
  });
});

describe('N25 step states and thought lifecycle', () => {
  it('four labeled states and matching live heading pending dot', async () => {
    const v = await view('StepGroup', { live: true, steps: ['pending', 'ok', 'failed', 'interrupted'].map(status => ({ status, name: 'tool', title: status })) });
    expect(v.render().filter(n => n.props?.role === 'img').map(n => [n.props!.class, n.props!['aria-label']])).toEqual([['dot pending', '进行中']]);
    v.render().find(n => n.type === 'button')!.props!.onClick();
    expect(v.render().filter(n => n.props?.role === 'img').map(n => [n.props!.class, n.props!['aria-label']])).toEqual([['dot pending', '进行中'], ['dot pending', '进行中'], ['dot', '成功'], ['dot bad', '失败'], ['dot intr', '已中断 · 结果未知']]);
  });
  it('live thought stays open and aria disabled, history freely opens with original body then cleans without events', async () => {
    const live = await view('ThinkBlock', { text: 'live body', live: true });
    const button = () => live.render().find(n => n.type === 'button')!;
    expect(button().props).toMatchObject({ 'aria-disabled': true, 'aria-expanded': true, title: '生成中保持展开' });
    button().props!.onClick(); expect(button().props!['aria-expanded']).toBe(true);
    const history = await view('ThinkBlock', { text: 'unique history body', live: false });
    const hb = () => history.render().find(n => n.type === 'button')!;
    const body = () => history.render().filter(n => cls(n, 'tinner')).map(n => n.children);
    expect(body()).toEqual([]); hb().props!.onClick(); expect(body()).toEqual(['unique history body']); expect(hb().props!['aria-expanded']).toBe(true);
    hb().props!.onClick(); expect(body()).toEqual(['unique history body']);
    vi.advanceTimersByTime(220); expect(body()).toEqual([]);
  });
  it('only own grid transition removes body; reopen cancels pending cleanup; unmount cancels timer', async () => {
    const v = await view('ThinkBlock', { text: 'body', live: false });const click = () => v.render().find(n => n.type === 'button')!.props!.onClick();
    const grid = () => v.render().find(n => cls(n, 'tbody'))!;const body = () => v.render().filter(n => cls(n, 'tinner'));
    click(); click(); const target = {}; grid().props!.onTransitionend({ target, currentTarget: {}, propertyName: 'grid-template-rows' }); expect(body()).toHaveLength(1);
    grid().props!.onTransitionend({ target, currentTarget: target, propertyName: 'opacity' }); expect(body()).toHaveLength(1);
    click(); vi.advanceTimersByTime(250); expect(body()).toHaveLength(1);click();
    grid().props!.onTransitionend({ target, currentTarget: target, propertyName: 'grid-template-rows' }); expect(body()).toHaveLength(0);
    click(); click(); expect(vi.getTimerCount()).toBe(1); v.s.unmount();disposers.pop(); expect(vi.getTimerCount()).toBe(0);
  });
  it('reduced motion removes closed body immediately', async () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) });const v = await view('ThinkBlock', { text: 'body', live: false });const click = () => v.render().find(n => n.type === 'button')!.props!.onClick();
    click(); expect(v.render().some(n => cls(n, 'tinner'))).toBe(true);click(); expect(v.render().some(n => cls(n, 'tinner'))).toBe(false);expect(vi.getTimerCount()).toBe(0);
  });
});
