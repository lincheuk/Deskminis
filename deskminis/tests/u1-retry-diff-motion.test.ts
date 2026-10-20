import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, reactive, type VNode } from 'vue';
import { join } from 'node:path';
const probe = vi.hoisted(() => ({ call: vi.fn(), on: vi.fn(), handlers: new Map<string, (p: any) => unknown>(), lost: vi.fn(), connect: vi.fn(async () => {}) }));
vi.mock('../src/renderer/src/rpc', () => ({ rpc: { call: probe.call, on: probe.on, onLost: probe.lost, connect: probe.connect } }));
import { initStore, resetStoreRpc } from './renderer-store-fixture';
import { runSetup } from './sfc-setup';
import { lineDiff } from '../src/renderer/src/lib/changes/model';
const UI = join(__dirname, '../src/renderer/src/ui');
const nodes = (v: any): VNode[] => Array.isArray(v) ? v.flatMap(nodes) : v && typeof v === 'object' && 'type' in v ? [v, ...nodes(v.children)] : [];
beforeEach(() => { resetStoreRpc(probe); vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] }); vi.setSystemTime(100000); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const renderer = async (name: string, props: Record<string, unknown>) => {
  const s = await runSetup<(ctx: object, cache: unknown[]) => VNode>(join(UI, name + '.vue'), props, effectScope(), { inlineTemplate: true });
  return { s, render: () => nodes(s.bindings({}, [])) };
};
describe('U1 retry display uses actual store event timing and lifecycle', () => {
  for (const ending of ['textDelta', 'turnEnd', 'error', 'cancel', 'switch']) it('seconds, zero, previous attempts and end=' + ending, async () => {
    const chat = await initStore(probe); chat.activeId = 'A';
    const { s, render } = await renderer('EventNotes', {});
    try {
      const shorts = () => render().filter(n => n.props?.class === 'short').map(n => n.children);
      chat.onEvent({ kind: 'retry', attempt: 1, delayMs: 2000 }); expect(shorts()).toEqual(['2 秒后重试（第 1 次）']);
      vi.advanceTimersByTime(1000); expect(shorts()).toEqual(['1 秒后重试（第 1 次）']);
      vi.advanceTimersByTime(1000); expect(shorts()).toEqual(['正在重试（第 1 次）']);
      chat.onEvent({ kind: 'retry', attempt: 2, delayMs: 3500 }); expect(shorts()).toEqual(['重试记录（第 1 次）', '4 秒后重试（第 2 次）']);
      vi.advanceTimersByTime(1000); expect(shorts()[1]).toBe('3 秒后重试（第 2 次）');
      if (ending === 'cancel') { await chat.cancel(); chat.onEvent({ kind: 'turnEnd', stopReason: 'cancelled' }); }
      else if (ending === 'switch') await chat.open('B');
      else chat.onEvent(ending === 'textDelta' ? { kind: 'textDelta', text: 'result' } : ending === 'error' ? { kind: 'error', message: 'synthetic' } : { kind: 'turnEnd' });
      await nextTick();
      expect(chat.retryNote).toBe('');
      expect(shorts().filter(t => /秒后重试|正在重试/.test(String(t)))).toEqual([]);
      if (ending !== 'switch') expect(shorts()[0]).toBe('重试记录（第 1 次）');
      else { chat.onEvent({ kind: 'retry', attempt: 1, delayMs: 1000 }); expect(shorts()).toEqual(['1 秒后重试（第 1 次）']); }
    } finally { s.unmount(); }
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('U1 diff line numbers', () => {
  const before = Array.from({ length: 30 }, (_, i) => i === 20 ? 'old' : 'same ' + i).join('\n');
  const after = before.replace('old', 'new\ninserted');
  it('checkpoint passes actual prefixed file numbers; both columns render and empty sides stay empty', async () => {
    const diff: any = { change: { kind: 'modify', displayPath: 'src/a.ts', path: 'C:/synthetic/src/a.ts', toolName: 'file_edit' }, before: { exists: true, source: 'blob', form: 'text', text: before }, after: { exists: true, source: 'file', form: 'text', text: after }, current: { exists: true }, currentIs: 'after' };
    const props = { diff, verdict: null, message: '', laterHere: [], laterElsewhere: [], sessionTitles: {}, confirming: null, result: null, saved: '', busy: false, error: '' };
    const review = await renderer('ChangeReviewView', props);
    let view: Awaited<ReturnType<typeof renderer>> | undefined;
    try {
      const child = review.render().find(n => (n.type as any)?.name === './UiDiff.vue')!;
      expect(child.props?.['line-numbers'] ?? child.props?.lineNumbers).not.toBeUndefined();
      const numbers = child.props!.lines.map((l: any) => [l.oldNo ?? '', l.newNo ?? '']);
      expect(child.props!.lines.filter((l: any) => l.type !== 'ctx').map((l: any) => [l.oldNo, l.newNo])).toEqual([[21, undefined], [undefined, 21], [undefined, 22]]);
      view = await renderer('UiDiff', { lines: child.props!.lines, addCount: child.props!['add-count'], delCount: child.props!['del-count'], lineNumbers: true });
      // N25：折叠先隐藏远处行，展开后仍逐一核对整份原始行号。
      for (const button of view.render().filter(n => n.type === 'button')) button.props!.onClick();
      expect(view.render().filter(n => String(n.props?.class).includes('no tnum')).map(n => n.children)).toEqual(numbers.flat().map(String));
      expect(view.render().filter(n => String(n.props?.class).includes('no tnum')).every(n => n.props?.['aria-hidden'] === 'true')).toBe(true);
    } finally { review.s.unmount(); view?.s.unmount(); }
  });
  it('default UiDiff, permission preview and expanded step preview do not request line numbers', async () => {
    await initStore(probe);
    const cmp = lineDiff(before, after); if (cmp.tooLarge) throw Error('fixture');
    const diff = await renderer('UiDiff', { lines: cmp.lines, addCount: cmp.add, delCount: cmp.del });
    const perm = await renderer('PermCard', { perm: { requestId: 'R', kind: 'file-write', detail: 'a.ts', toolTitle: '', preview: { oldText: before, newText: after } } });
    const step = await renderer('StepGroup', { steps: [{ name: 'file_edit', status: 'ok', title: 'edit', input: JSON.stringify({ path: 'a.ts', old_string: 'old', new_string: 'new' }) }] });
    try {
      expect(diff.render().filter(n => String(n.props?.class).includes('no tnum'))).toEqual([]);
      step.render().find(n => n.type === 'button')!.props!.onClick();
      for (const child of [perm.render(), step.render()].map(ns => ns.find(n => (n.type as any)?.name === './UiDiff.vue')!)) {
        expect(child).toBeDefined(); expect(child.props?.['line-numbers']).toBeUndefined(); expect(child.props?.lineNumbers).toBeUndefined();
      }
    } finally { diff.s.unmount(); perm.s.unmount(); step.s.unmount(); }
  });
});

describe('U1 reduced motion scroll', () => {
  for (const reduce of [true, false]) it('actual StageChat jump sends ' + (reduce ? 'auto' : 'smooth'), async () => {
    await initStore(probe);
    vi.stubGlobal('window', { matchMedia: (query: string) => ({ matches: query === '(prefers-reduced-motion: reduce)' && reduce }) });
    const scrollIntoView = vi.fn(); const querySelector = vi.fn(() => ({ scrollIntoView }));
    const s = await runSetup<any>(join(UI, 'StageChat.vue'), {}, effectScope());
    try { s.bindings.scroller.value = { querySelector, scrollHeight: 100, scrollTop: 0, clientHeight: 10 }; s.bindings.jumpTurn('synthetic'); expect(querySelector).toHaveBeenCalledWith('[data-turn-id="synthetic"]'); expect(scrollIntoView).toHaveBeenCalledWith({ behavior: reduce ? 'auto' : 'smooth', block: 'start' }); }
    finally { s.unmount(); }
  });
});

describe('U1b retry fractional timing and request identity', () => {
  it('2.4 seconds rounds up to 3, 0.4 stays at 1, and only elapsed waits say retrying', async () => {
    const chat = await initStore(probe); chat.activeId = 'A';
    const { s, render } = await renderer('EventNotes', {});
    const short = () => render().find(n => n.props?.class === 'short')!.children;
    try {
      chat.onEvent({ kind: 'retry', attempt: 1, delayMs: 3400 });
      vi.advanceTimersByTime(1000);
      expect(short()).toBe('3 秒后重试（第 1 次）');
      vi.advanceTimersByTime(2000);
      expect(short()).toBe('1 秒后重试（第 1 次）');
      vi.advanceTimersByTime(1000);
      expect(short()).toBe('正在重试（第 1 次）');
    } finally { s.unmount(); }
  });

  it('an event 0.6 seconds after the previous tick starts at its own delay', async () => {
    const chat = await initStore(probe); chat.activeId = 'A';
    const { s, render } = await renderer('EventNotes', {});
    const short = () => render().find(n => n.props?.class === 'short')!.children;
    try {
      vi.advanceTimersByTime(600);
      chat.onEvent({ kind: 'retry', attempt: 1, delayMs: 3000 });
      expect(short()).toBe('3 秒后重试（第 1 次）');
      vi.advanceTimersByTime(400);
      expect(short()).toBe('3 秒后重试（第 1 次）');
    } finally { s.unmount(); }
  });

  it('two requests in one turn can both have attempt 1; only the latest record counts down', async () => {
    const chat = await initStore(probe); chat.activeId = 'A';
    const { s, render } = await renderer('EventNotes', {});
    const shorts = () => render().filter(n => n.props?.class === 'short').map(n => n.children);
    try {
      chat.onEvent({ kind: 'retry', attempt: 1, delayMs: 2000 });
      vi.advanceTimersByTime(1000);
      chat.onEvent({ kind: 'textDelta', text: 'first request returned' });
      expect(shorts()).toEqual(['重试记录（第 1 次）']);
      chat.onEvent({ kind: 'retry', attempt: 1, delayMs: 3000 });
      expect(chat.eventNotes).toHaveLength(2);
      expect(shorts()).toEqual(['重试记录（第 1 次）', '3 秒后重试（第 1 次）']);
      vi.advanceTimersByTime(1000);
      expect(shorts()).toEqual(['重试记录（第 1 次）', '2 秒后重试（第 1 次）']);
    } finally { s.unmount(); }
  });
});

it('U1b both line-number columns fit the largest number, keep a four-digit minimum and resize with props', async () => {
  const props = reactive({ lines: [{ type: 'ctx' as const, text: 'context', oldNo: 1, newNo: 1 }], addCount: 0, delCount: 0, lineNumbers: true });
  const view = await renderer('UiDiff', props);
  try {
    for (const [oldNo, newNo, expected] of [[1, 1, '4ch'], [9999, 99, '4ch'], [12345, 21, '5ch'], [21, 123456, '6ch'], [1, 1, '4ch']] as const) {
      props.lines = [{ type: 'ctx', text: 'context', oldNo, newNo }];
      await nextTick();
      const columns = view.render().filter(n => String(n.props?.class).includes('no tnum'));
      expect(columns.map(n => n.children)).toEqual([String(oldNo), String(newNo)]);
      expect(columns.map(n => n.props?.style?.flexBasis)).toEqual([expected, expected]);
    }
  } finally { view.s.unmount(); }
});
