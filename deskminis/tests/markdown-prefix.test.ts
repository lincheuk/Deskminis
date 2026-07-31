/** MU2a Task 1：流式稳定前缀切分（决策 3，5 例）。
 *  stablePrefixEnd(src)：「最后完整块边界」= 成对空行（\n\n）之后、且不在未闭合代码围栏内的最后一个偏移。 */
import { describe, it, expect } from 'vitest';
import { stablePrefixEnd } from '../src/renderer/src/lib/markdown/prefix';

describe('MU2a Task 1 stablePrefixEnd', () => {
  it('空行成对处切：返回最后一个 \\n\\n 之后的偏移', () => {
    expect(stablePrefixEnd('a\n\nb')).toBe(3);
    expect(stablePrefixEnd('one\n\ntwo\n\nthree')).toBe(10);
  });

  it('未闭合围栏内不切：边界落在未闭合围栏之后时回退到围栏开始前的边界', () => {
    // 边界 11 在 "```js\ncode" 之后，但该前缀围栏未闭合 → 不可用；无更早边界 → 0（= 围栏开始位置）
    expect(stablePrefixEnd('```js\ncode\n\nmore')).toBe(0);
    // 围栏开始前已有可用边界 4 → 返回 4
    expect(stablePrefixEnd('ok\n\n```js\ncode\n\nmore')).toBe(4);
  });

  it('全文无空行 → 0', () => {
    expect(stablePrefixEnd('no breaks here')).toBe(0);
    expect(stablePrefixEnd('')).toBe(0);
  });

  it('尾部就是边界时幂等：src 以 \\n\\n 结尾 → 返回 src.length', () => {
    expect(stablePrefixEnd('done\n\n')).toBe(6);
    // 再次调用结果不变（幂等）
    const s = 'x\n\ny\n\n';
    expect(stablePrefixEnd(s.slice(0, stablePrefixEnd(s)))).toBe(6);
  });

  it('\\r\\n 文档：空行对 \\r\\n\\r\\n 同样成边界', () => {
    expect(stablePrefixEnd('a\r\n\r\nb')).toBe(5);
    expect(stablePrefixEnd('```js\r\ncode\r\n\r\nmore')).toBe(0);
  });
});
