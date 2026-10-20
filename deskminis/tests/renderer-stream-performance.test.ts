import { describe, expect, it } from 'vitest';
import { q11ComponentProbe } from './helpers/q11-probe-loader';
import { createHistoryMarkdownCache } from '../src/renderer/src/lib/markdown/history-cache';
import { parseMarkdown } from '../src/renderer/src/lib/markdown/parse';

describe('Q11 实际 Vue 组件与历史缓存', () => {
  it('贴底已排两帧后立刻点导航，旧回调不能抢回底部', async () => {
    const p = await q11ComponentProbe();
    expect(p.pendingNavigation.queuedFrames).toBeGreaterThan(0);expect(p.pendingNavigation.scrollTop).toBe(0);
  });
  it('Q11b 跳到远处停下后不再跟随新内容', async () => {
    expect((await q11ComponentProbe()).jumpAway).toEqual({ scrollTop: 0 });
  });
  it('Q11b 贴底时点「正在进行的回合」画面不动：跳转期间不贴底，收尾后补上并继续跟随', async () => {
    expect((await q11ComponentProbe()).stillJump).toEqual({ during: 900, afterIdle: 1400, nextDelta: 1800 });
  });
  it('Q11b 平滑滚动头一帧离底部不到 120 时来了新内容，不把画面拉回底部；停在远处后不跟随', async () => {
    expect((await q11ComponentProbe()).movingJump).toEqual({ firstFrame: 1650, stillScrolling: 1650, end: 200 });
  });
  it('H 历史块、N 正文/思考增量：初次 H 次，之后历史解析和父组件更新均为 0', async () => {
    const p = await q11ComponentProbe();
    expect(p.count).toEqual({ initialParses: 12, historyParses: 0, stageUpdates: 0, H: 12, N: 24 });
  });
  it('历史与流式正文都真正通过 MarkdownView，用户文本不解析；两种思考都有显示', async () => {
    expect((await q11ComponentProbe()).wiring).toEqual({ historyUsesMarkdown: true, liveUsesMarkdown: true, userPlain: true, liveThinking: true, historyThinking: true });
  });
  it('同 id 修改文本只重新解析该块，多个文本块不互相覆盖', async () => {
    const p = await q11ComponentProbe();
    expect(p.edit).toEqual({ reparses: 1, changedVisible: true });
    expect(p.multipleBlocks).toEqual({ reparses: 1, texts: ['HIST-1 history bold', 'HIST-second separate'] });
  });
  it('重试、备用模型、上下文重发均即时清掉正文和思考', async () => {
    const p = await q11ComponentProbe();
    for (const value of [p.retry,p.fallback,p.recovery]) expect(value).toEqual({ text: '', thinking: '' });
  });
  it('16 组随机 UTF-16 切分穿插重试/降级/恢复及断线快照/续传校正，最终正文和思考不重不漏', async () => {
    const p = await q11ComponentProbe();
    expect(p.randomCases).toHaveLength(16);
    expect(p.randomCases.flatMap((r: any) => r.resets).length).toBeGreaterThan(0);
    expect(p.randomCases.reduce((n: number,r: any) => n + r.resumes,0)).toBeGreaterThan(0);
    for (const r of p.randomCases) { expect(r.actual).toBe(r.expected); expect(r.actualRenderedBody).toBe(r.expectedRenderedBody); expect(r.actualThinking).toBe(r.expectedThinking); }
  });
  it('真实 refreshJoinedHistory 在途追加：切掉落库前缀，后到正文与思考只保留尾巴', async () => {
    expect((await q11ComponentProbe()).tail).toEqual({ text: 'late-tail', thinking: 'late-thought', persisted: ['persisted-prefix'], canonical: 'late-tail' });
  });
  it('缓存只保留当前消息/文本，移除或换会话后不保留旧解析', () => {
    let calls = 0;
    const cache = createHistoryMarkdownCache(text => { calls++; return parseMarkdown(text); });
    cache.begin();const a = cache.nodes('a','**one**'), b = cache.nodes('a','**two**');cache.end();
    cache.begin();expect(cache.nodes('a','**one**')).toBe(a);expect(cache.nodes('a','**two**')).toBe(b);cache.end();expect(calls).toBe(2);
    cache.begin();cache.nodes('a','changed');cache.end();expect(calls).toBe(3);
    cache.begin();expect(cache.nodes('a','**one**')).not.toBe(a);cache.end();expect(calls).toBe(4);
    cache.begin();cache.end();cache.begin();cache.nodes('a','**one**');cache.end();expect(calls).toBe(5);
  });
});
