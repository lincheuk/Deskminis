import { describe, it, expect } from 'vitest';
import { encodeFrame, FrameDecoder, MAX_FRAME_BYTES } from '../src/minisd/bridge/frame';

describe('encodeFrame / FrameDecoder', () => {
  it('单帧往返一致（含中文与嵌套对象）', () => {
    const payload = { tool: 'windows-notify', action: 'show', args: { title: '标题①' }, sessionId: 'S1', stdin: '多行\n文本' };
    const frames = new FrameDecoder().push(encodeFrame(payload));
    expect(frames).toHaveLength(1);
    expect(JSON.parse(frames[0].toString('utf8'))).toEqual(payload);
  });

  it('半包：逐字节滴入，收齐才出帧', () => {
    const wire = encodeFrame({ a: 1 });
    const dec = new FrameDecoder();
    for (let i = 0; i < wire.length - 1; i++) {
      expect(dec.push(wire.subarray(i, i + 1))).toEqual([]);
    }
    const out = dec.push(wire.subarray(wire.length - 1));
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].toString('utf8'))).toEqual({ a: 1 });
  });

  it('粘包：两帧一次推入，拆出两帧且保序', () => {
    const wire = Buffer.concat([encodeFrame({ n: 1 }), encodeFrame({ n: 2 })]);
    const out = new FrameDecoder().push(wire);
    expect(out.map(f => JSON.parse(f.toString('utf8')).n)).toEqual([1, 2]);
  });

  it('粘包+半包混合：帧跨两次推入边界', () => {
    const f1 = encodeFrame('甲');
    const f2 = encodeFrame('乙');
    const wire = Buffer.concat([f1, f2]);
    const dec = new FrameDecoder();
    const cut = f1.length - 2; // 第一帧差 2 字节处切开
    expect(dec.push(wire.subarray(0, cut))).toEqual([]);
    const out = dec.push(wire.subarray(cut));
    expect(out.map(f => f.toString('utf8'))).toEqual(['"甲"', '"乙"']);
  });

  it('长度头超上限：抛错且解码器复位（后续新帧不受影响）', () => {
    const dec = new FrameDecoder();
    const evil = Buffer.alloc(4);
    evil.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
    expect(() => dec.push(evil)).toThrow(/超过上限/);
    // 复位后正常帧仍可用
    const out = dec.push(encodeFrame({ ok: true }));
    expect(JSON.parse(out[0].toString('utf8'))).toEqual({ ok: true });
  });

  it('长度恰好等于上限：放行', () => {
    const dec = new FrameDecoder();
    const head = Buffer.alloc(4);
    head.writeUInt32BE(MAX_FRAME_BYTES, 0);
    expect(dec.push(head)).toEqual([]); // 不抛错，等体
  });

  it('encodeFrame 体超上限直接抛错', () => {
    expect(() => encodeFrame({ big: 'x'.repeat(MAX_FRAME_BYTES) })).toThrow(/超过上限/);
  });
});
