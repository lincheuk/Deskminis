/** 主进程看管子进程输出用的小工具。不 import electron，便于单测。 */

/** minisd stderr 保留的末尾字节数（设计稿 §3 第 8 条：约 4KB，只实现这一次，崩溃记录等后续步骤复用）。 */
export const STDERR_TAIL_BYTES = 4096;

/** 定长环形缓冲：只留最近 capacity 字节。
 *  为什么不直接拼字符串：stderr 在进程整个生命周期里都在写，拼接要么无限长、要么每次都重新切片；
 *  这里固定一块内存，写满就覆盖最旧的，取尾巴时才解码。 */
export class TailBuffer {
  private readonly buf: Buffer;
  private start = 0;   // 最旧字节的位置
  private size = 0;    // 当前有效字节数

  constructor(readonly capacity: number = STDERR_TAIL_BYTES) {
    this.buf = Buffer.alloc(capacity);
  }

  push(chunk: Buffer | string): void {
    let b = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    if (b.length === 0) return;
    if (b.length >= this.capacity) {
      // 一块就比容量大：前面的旧内容和这块的开头都不要了
      b = b.subarray(b.length - this.capacity);
      b.copy(this.buf, 0);
      this.start = 0;
      this.size = this.capacity;
      return;
    }
    let end = (this.start + this.size) % this.capacity;
    for (let off = 0; off < b.length;) {
      const n = Math.min(b.length - off, this.capacity - end);
      b.copy(this.buf, end, off, off + n);
      off += n;
      end = (end + n) % this.capacity;
    }
    const overflow = this.size + b.length - this.capacity;
    if (overflow > 0) {
      this.start = (this.start + overflow) % this.capacity;
      this.size = this.capacity;
    } else {
      this.size += b.length;
    }
  }

  /** 按 UTF-8 解码当前内容。截断点可能落在多字节字符中间：丢掉开头的续字节，免得出现替换符。 */
  text(): string {
    if (this.size === 0) return '';
    const head = this.buf.subarray(this.start, Math.min(this.start + this.size, this.capacity));
    const wrapped = this.start + this.size > this.capacity ? this.buf.subarray(0, this.start + this.size - this.capacity) : undefined;
    const all = wrapped ? Buffer.concat([head, wrapped]) : head;
    let i = 0;
    while (i < all.length && i < 4 && (all[i] & 0xc0) === 0x80) i++;
    return all.subarray(i).toString('utf8');
  }
}
