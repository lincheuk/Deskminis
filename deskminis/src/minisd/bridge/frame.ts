/** 桥线协议帧：4 字节大端 uint32 长度前缀 + UTF-8 JSON 体（借鉴 Android NOFF/NOFR 的长度前缀帧思想，格式自定）。
 *  上限 16MB：正常信封远在 1MB 内（剪贴板读在 handler 层已截断 1MB），上限只用于防畸形对端撑爆内存。 */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export function encodeFrame(payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  if (body.length > MAX_FRAME_BYTES) throw new Error(`帧体 ${body.length} 超过上限 ${MAX_FRAME_BYTES}`);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}

/** 增量帧解码器：任意切块推入（半包缓冲、粘包拆帧），返回本轮新收齐的帧体（不含长度头）。 */
export class FrameDecoder {
  private buf = Buffer.alloc(0);

  constructor(private maxBytes = MAX_FRAME_BYTES) {}

  push(chunk: Buffer): Buffer[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out: Buffer[] = [];
    while (true) {
      if (this.buf.length < 4) return out;
      const len = this.buf.readUInt32BE(0);
      if (len > this.maxBytes) {
        // 畸形对端：复位缓冲再抛，让调用方有机会回一帧错误信封而不是僵死
        this.buf = Buffer.alloc(0);
        throw new Error(`帧长度 ${len} 超过上限 ${this.maxBytes}`);
      }
      if (this.buf.length < 4 + len) return out;
      out.push(this.buf.subarray(4, 4 + len));
      this.buf = this.buf.subarray(4 + len);
    }
  }
}
