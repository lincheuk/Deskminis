/** 主进程看管子进程输出用的小工具。不 import electron，便于单测。 */
import { StringDecoder } from 'node:string_decoder';

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

/** LineSplitter 攒着没换行的半行最多这么长（字符），超过就先切出来：子进程一直不换行地输出时，不能无限攒在内存里。 */
export const LINE_SPLITTER_MAX_CHARS = 64 * 1024;

/** 把分块到达的子进程输出切成整行（W2b-7：stderr 以前整块转发，按天日志要按行记、每行带时间）。
 *  一块可能断在一行中间、甚至一个汉字中间：半行留到下一块，多字节字符由 StringDecoder 拼回，不出替换符。
 *  去掉行尾的 \r；空行与纯空白行不要（按天日志里只是噪音）。 */
export class LineSplitter {
  private readonly decoder = new StringDecoder('utf8');
  private rest = '';

  /** 喂一块，返回这一块凑齐的整行。 */
  push(chunk: Buffer | string): string[] {
    this.rest += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    const lines = this.rest.split('\n');
    this.rest = lines.pop() ?? '';
    while (this.rest.length > LINE_SPLITTER_MAX_CHARS) {
      lines.push(this.rest.slice(0, LINE_SPLITTER_MAX_CHARS));
      this.rest = this.rest.slice(LINE_SPLITTER_MAX_CHARS);
    }
    return tidy(lines);
  }

  /** 收尾（子进程退出时）：把最后没换行的半行交出来。 */
  flush(): string[] {
    const last = this.rest + this.decoder.end();
    this.rest = '';
    return tidy([last]);
  }
}

function tidy(lines: string[]): string[] {
  return lines.map(l => l.replace(/\r$/, '')).filter(l => l.trim() !== '');
}
