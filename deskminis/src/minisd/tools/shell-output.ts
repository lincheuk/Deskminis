import { StringDecoder } from 'node:string_decoder';

/** 工具仍按 UTF-16 长度取前 100KB；多留一个字符，使原有截断提示照常触发。 */
export const SHELL_OUTPUT_LIMIT = 100 * 1024;
const HEAD_CHARS = SHELL_OUTPUT_LIMIT + 1;

/** 每种编码最多保存 200KB + 2 字节，丢弃中段后仍统计长度和最后一个非空白位置。
 *  因此长空白尾巴的 trimEnd 与晚到的非空白字符都不会改变原来的截断行为。 */
class DecodedHead {
  private head: Buffer | undefined;
  private kept = 0;
  private length = 0;
  private lastContent = 0;
  private cr = false;

  append(text: string): void {
    if (text.length === 0) return;
    if (this.cr) text = '\r' + text;
    this.cr = text.endsWith('\r');
    if (this.cr) text = text.slice(0, -1);
    this.keep(text.replace(/\r\n/g, '\n'));
  }

  private keep(text: string): void {
    const content = text.trimEnd().length;
    if (content > 0) this.lastContent = this.length + content;
    this.length += text.length;
    const take = Math.min(text.length, HEAD_CHARS - this.kept);
    if (take === 0) return;
    this.head ??= Buffer.allocUnsafe(HEAD_CHARS * 2);
    // UTF-16 复制保留原先 slice 的码元语义（包括落在代理对中间的截断）。
    this.head.write(text.slice(0, take), this.kept * 2, take * 2, 'utf16le');
    this.kept += take;
  }

  finish(trimEnd: boolean): string {
    if (this.cr) { this.keep('\r'); this.cr = false; }
    const end = Math.min(this.kept, trimEnd ? this.lastContent : this.length);
    return this.head?.toString('utf16le', 0, end * 2) ?? '';
  }
}

/** 与 decodeShellOutput 的整体 U+FFFD 判定相同，连丢弃的中段也参与判定。
 *  两个流式解码器各自保存受限头部；不截原始多字节序列，不积累原始字节。
 *  合计头部字节上限为 400KB + 4 字节，另有解码器的几个待续字节。 */
export class ShellOutput {
  private readonly utf8 = new StringDecoder('utf8');
  private readonly utf8Head = new DecodedHead();
  private readonly gbkHead = new DecodedHead();
  private readonly gbk: TextDecoder | undefined;
  private replacement = false;
  bytes = 0;

  constructor() {
    try { this.gbk = new TextDecoder('gbk'); } catch { /* 同原解码器：无 GBK 时退回 UTF-8 */ }
  }

  append(bytes: Buffer): void {
    this.bytes += bytes.length;
    const text = this.utf8.write(bytes);
    this.replacement ||= text.includes('\uFFFD');
    this.utf8Head.append(text);
    if (this.gbk) this.gbkHead.append(this.gbk.decode(bytes, { stream: true }));
  }

  finish(trimEnd: boolean): string {
    const tail = this.utf8.end();
    this.replacement ||= tail.includes('\uFFFD');
    this.utf8Head.append(tail);
    if (this.gbk) this.gbkHead.append(this.gbk.decode());
    return (this.replacement && this.gbk ? this.gbkHead : this.utf8Head).finish(trimEnd);
  }
}
