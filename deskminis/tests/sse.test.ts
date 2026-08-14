import { describe, it, expect } from 'vitest';
import { parseSse } from '../src/minisd/providers/sse';
import { ProviderError } from '../src/minisd/providers/types';

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      // 故意按奇怪的边界切块，验证跨块缓冲
      for (let i = 0; i < text.length; i += 7) c.enqueue(new TextEncoder().encode(text.slice(i, i + 7)));
      c.close();
    },
  });
}

describe('parseSse', () => {
  it('按帧解析 event 与多行 data', async () => {
    const frames: { event?: string; data: string }[] = [];
    const src = 'event: message_start\ndata: {"a":1}\n\n: comment\n\ndata: line1\ndata: line2\n\n';
    for await (const f of parseSse(streamOf(src))) frames.push(f);
    expect(frames).toEqual([
      { event: 'message_start', data: '{"a":1}' },
      { event: undefined, data: 'line1\nline2' },
    ]);
  });
  it('残帧在流关闭时丢弃', async () => {
    const frames: unknown[] = [];
    for await (const f of parseSse(streamOf('data: {"x":1}\n\ndata: 未闭合'))) frames.push(f);
    expect(frames).toHaveLength(1);
  });

  it('CRLF 行尾解析结果与 LF 完全一致(只认 \\n\\n 的话一个事件都出不来)', async () => {
    const lf = 'event: message_start\ndata: {"a":1}\n\n: comment\n\ndata: line1\ndata: line2\n\n';
    const crlf = lf.replace(/\n/g, '\r\n');
    const readLf: unknown[] = []; const readCrlf: unknown[] = [];
    for await (const f of parseSse(streamOf(lf))) readLf.push(f);
    // 7 字节切块会把 '\r' 和 '\n' 拆到两块里：孤立的 '\r' 必须能和下一块的 '\n' 配上对
    for await (const f of parseSse(streamOf(crlf))) readCrlf.push(f);
    expect(readCrlf).toEqual(readLf);
    expect(readCrlf).toEqual([
      { event: 'message_start', data: '{"a":1}' },
      { event: undefined, data: 'line1\nline2' },
    ]);
  });

  it('裸 CR 行尾（\\r 作行终止符、\\r\\r 作帧分隔）解析结果与 LF 完全一致', async () => {
    // SSE 规范也允许裸 CR 行尾；未归一时 '\r\r' 永远配不出 '\n\n'，provider 会抛「流提前结束」。
    // 末尾附一个 keep-alive 注释帧（真实流常见）：确保最后一个数据帧在流关闭前被 '\r\r' 完整终止，
    // 而结尾那个落在流末尾的孤立 '\r' 被 (?!$) 保留待下一块——这里没有下一块，仅剩注释残帧被丢弃。
    const lf = 'event: message_start\ndata: {"a":1}\n\ndata: line1\ndata: line2\n\n: keep-alive\n\n';
    const cr = lf.replace(/\n/g, '\r');
    const readLf: unknown[] = []; const readCr: unknown[] = [];
    for await (const f of parseSse(streamOf(lf))) readLf.push(f);
    // 7 字节切块会把相邻的两个 '\r' 拆到两块里：跨块缓冲必须把裸 CR 也当帧边界
    for await (const f of parseSse(streamOf(cr))) readCr.push(f);
    expect(readCr).toEqual(readLf);
    expect(readCr).toEqual([
      { event: 'message_start', data: '{"a":1}' },
      { event: undefined, data: 'line1\nline2' },
    ]);
  });

  it('流停滞(连接不关闭也不发数据) → idleTimeoutMs 后 cancel 流并抛 retryable 错误', async () => {
    let cancelCalled = false;
    const encoder = new TextEncoder();
    // 吐一帧后既不 close 也不再 enqueue：reader.read() 将永久挂起
    const stalled = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(encoder.encode('data: {"a":1}\n\n')); },
      cancel() { cancelCalled = true; },
    });
    const frames: unknown[] = [];
    let caught: unknown;
    try { for await (const f of parseSse(stalled, 50)) frames.push(f); } catch (e) { caught = e; }
    // 停滞前的那一帧正常吐出
    expect(frames).toEqual([{ event: undefined, data: '{"a":1}' }]);
    expect(caught).toBeInstanceOf(ProviderError);
    const err = caught as ProviderError;
    expect(err.message).toBe('SSE 流停滞超时');
    expect(err.retryable).toBe(true); // retryable 才能走既有重试梯，否则用户只能手动取消
    expect(cancelCalled).toBe(true);  // 底层连接必须被释放，不能只抛错任由 socket 挂着
  });
});
