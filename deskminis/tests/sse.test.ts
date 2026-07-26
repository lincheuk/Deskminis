import { describe, it, expect } from 'vitest';
import { parseSse } from '../src/minisd/providers/sse';

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
});
