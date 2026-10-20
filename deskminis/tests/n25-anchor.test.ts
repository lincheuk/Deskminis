import { describe, expect, it } from 'vitest';
import { holdTextAnchor } from '../src/renderer/src/lib/scroll-anchor';

describe('N25 live to history viewport anchor', () => {
  const block = (text: string, top: number, bottom = top + 32, tagName = 'P') => ({ textContent: text, tagName, getBoundingClientRect: () => ({ top, bottom }) });
  it('holds first visible surviving paragraph through DOM replacement, preserving fractional position', () => {
    let blocks = [block('above', -40, 0), block('same', 52.25), block('below', 400)];
    const scroller = { scrollTop: 2000, querySelectorAll: () => blocks, getBoundingClientRect: () => ({ top: 40, bottom: 800 }) };
    const restore = holdTextAnchor(scroller as any)!;
    blocks = [block('above', -10), block('same', 86.25), block('below', 434)];
    restore(); expect(scroller.scrollTop).toBe(2034);
  });
  it('repeated text uses occurrence and tag, missing anchor does not move viewport', () => {
    let blocks = [block('repeat', -40, 0), block('repeat', 52), block('repeat', 100, 140, 'LI')];
    const scroller = { scrollTop: 2000, querySelectorAll: () => blocks, getBoundingClientRect: () => ({ top: 40, bottom: 800 }) };
    const restore = holdTextAnchor(scroller as any)!;
    blocks = [block('repeat', -20), block('repeat', 60), block('repeat', 130, 170, 'LI')];restore();expect(scroller.scrollTop).toBe(2008);
    blocks = [];restore();expect(scroller.scrollTop).toBe(2008);expect(holdTextAnchor(scroller as any)).toBeUndefined();
  });
});
