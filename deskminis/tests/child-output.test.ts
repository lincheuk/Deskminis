/** W1a-8：minisd stderr 末尾 4KB 环形缓冲（src/main/child-output.ts 的 TailBuffer）。
 *  设计稿 §3 第 8 条：只实现这一次，W2b 的崩溃记录（stderrTail 字段）复用它，不另造第二个。 */
import { describe, it, expect } from 'vitest';
import { TailBuffer, STDERR_TAIL_BYTES } from '../src/main/child-output';

describe('TailBuffer（末尾环形缓冲）', () => {
  it('容量就是 4KB', () => {
    expect(STDERR_TAIL_BYTES).toBe(4096);
    expect(new TailBuffer(STDERR_TAIL_BYTES).capacity).toBe(4096);
  });

  it('没写过是空串；未满时按顺序原样拼接（Buffer 与字符串都收）', () => {
    const t = new TailBuffer(64);
    expect(t.text()).toBe('');
    t.push('abc');
    t.push(Buffer.from('def'));
    t.push('');
    expect(t.text()).toBe('abcdef');
  });

  it('写超了只留最后 capacity 字节，跨越回绕点也保持顺序', () => {
    const t = new TailBuffer(10);
    t.push('0123456');
    t.push('789AB');     // 回绕
    t.push('CDE');
    expect(t.text()).toBe('56789ABCDE');
  });

  it('单块比容量还大：只留它的末尾', () => {
    const t = new TailBuffer(8);
    t.push('xx');
    t.push('abcdefghijklmnop');
    expect(t.text()).toBe('ijklmnop');
  });

  it('截断点落在多字节字符中间时丢掉残半个字，不出现替换符 U+FFFD', () => {
    const t = new TailBuffer(10);
    t.push('启动失败了');          // 5 个汉字 = 15 字节，留最后 10 字节 → 第一个字符被截成残片
    const out = t.text();
    expect(out).not.toContain('�');
    expect(out).toBe('失败了');
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(10);
  });

  it('大量写入后仍只占 capacity 字节，内容是最后那一段', () => {
    const t = new TailBuffer(STDERR_TAIL_BYTES);
    for (let i = 0; i < 2000; i++) t.push(`line ${i}\n`);
    const out = t.text();
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(STDERR_TAIL_BYTES);
    expect(out.endsWith('line 1999\n')).toBe(true);
    expect(out).not.toContain('line 1000\n');
  });
});
