/** MU2a Task 3：词粒度淡入切分 diffWords（5 例）+ 滚动跟随判定 shouldFollow（4 例），纯模块。
 *  节奏参数（设计 §2.4/§8）：单批交错窗口 0.08s 均分（delay_i = i * 0.08/N，递增且 <0.08s），
 *  移植 OpenMinis TextFadeAnimator staggerWindow/count 思路（0.10→0.08 桌面适配）。 */
import { describe, it, expect } from 'vitest';
import { diffWords } from '../src/renderer/src/lib/fade/split';
import { shouldFollow } from '../src/renderer/src/lib/scroll/follow';

describe('MU2a Task 3 diffWords（5 例）', () => {
  it('prev 是 next 前缀 → added 词列 + 交错 delay（递增且 ≤0.08s）', () => {
    const d = diffWords('hello ', 'hello world foo');
    expect(d.stable).toBe('hello ');
    expect(d.added.map(w => w.word)).toEqual(['world ', 'foo']);
    expect(d.added[0].delay).toBe(0);
    expect(d.added[1].delay).toBeCloseTo(0.04, 10); // 0.08/2
    for (let i = 1; i < d.added.length; i++) {
      expect(d.added[i].delay).toBeGreaterThan(d.added[i - 1].delay);
      expect(d.added[i].delay).toBeLessThanOrEqual(0.08);
    }
  });

  it('prev 非前缀（流式重置）→ 整体重来（stable 空，全文重切）', () => {
    const d = diffWords('abc def', 'xyz');
    expect(d.stable).toBe('');
    expect(d.added.map(w => w.word)).toEqual(['xyz']);
    expect(d.added[0].delay).toBe(0);
  });

  it('空 prev → 全文为 added；空 next → added 空', () => {
    const d = diffWords('', 'a b');
    expect(d.stable).toBe('');
    expect(d.added.map(w => w.word)).toEqual(['a ', 'b']);
    expect(diffWords('x', 'x').added).toEqual([]);
  });

  it('词切分按空白 + 保留换行：空白归入前词，换行符保留在 token 内', () => {
    const d = diffWords('', 'hello world\nfoo  bar');
    expect(d.added.map(w => w.word)).toEqual(['hello ', 'world\n', 'foo  ', 'bar']);
  });

  it('CJK 连续字符按字粒度（含 CJK 标点）；拉丁与 CJK 交界处切分', () => {
    const d = diffWords('', '你好，世界');
    expect(d.added.map(w => w.word)).toEqual(['你', '好', '，', '世', '界']);
    expect(d.added[3].delay).toBeCloseTo(0.048, 10); // 3 * 0.08/5（5 词均分窗口）
    const d2 = diffWords('', 'hello世界');
    expect(d2.added.map(w => w.word)).toEqual(['hello', '世', '界']);
  });
});

describe('MU2a Task 3 shouldFollow（4 例）', () => {
  it('距底 ≤40 → true（prev=false 回到底部同样恢复跟随）', () => {
    expect(shouldFollow(100, 500, 380, false)).toBe(true); // dist=20
    expect(shouldFollow(60, 500, 400, true)).toBe(true);   // dist=40 边界
  });

  it('>40 且 prev=true → false（用户上翻解除跟随）', () => {
    expect(shouldFollow(0, 1000, 500, true)).toBe(false); // dist=500
  });

  it('解除后回到底部 → true', () => {
    expect(shouldFollow(500, 1000, 500, false)).toBe(true); // dist=0
  });

  it('prev=false 且仍 >40 → false（新内容到达不抢回）', () => {
    expect(shouldFollow(0, 1000, 500, false)).toBe(false);
    expect(shouldFollow(100, 1000, 500, false)).toBe(false); // dist=400
  });
});
