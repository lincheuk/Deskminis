/** F02 带图用例共用的图片字节：只有文件头是合法的（声明宽高），后面垫字节到指定大小——测的是「按尺寸估 token」，不解码像素。 */

const be32 = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const be16 = (n: number): number[] => [(n >>> 8) & 0xff, n & 0xff];
const le16 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff];
const le24 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff];
const ascii = (s: string): number[] => [...s].map(c => c.charCodeAt(0));
const pad = (head: number[], size: number): Buffer => Buffer.concat([Buffer.from(head), Buffer.alloc(Math.max(0, size - head.length), 0x41)]);

/** PNG：签名 + IHDR（偏移 16 起宽、高各 4 字节大端），后面垫到 size 字节。 */
export function pngBytes(width: number, height: number, size = 64): Buffer {
  return pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), ...ascii('IHDR'), ...be32(width), ...be32(height), 8, 6, 0, 0, 0, 0, 0, 0, 0], size);
}

/** JPEG：SOI + 若干 APP 段（每段 appBytes 字节的载荷）+ SOF0。appSegments 给大了就得到「SOF 落在文件头很后面」的图。 */
export function jpegBytes(width: number, height: number, opts: { appSegments?: number; appBytes?: number; size?: number } = {}): Buffer {
  const app = (n: number): number[] => [0xff, 0xe1, ...be16(n + 2), ...new Array<number>(n).fill(0x20)];
  const head = [0xff, 0xd8];
  for (let i = 0; i < (opts.appSegments ?? 1); i++) head.push(...app(opts.appBytes ?? 16));
  // SOF0：长度 17、精度 8、高、宽、3 个分量
  head.push(0xff, 0xc0, ...be16(17), 8, ...be16(height), ...be16(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1);
  return pad(head, opts.size ?? head.length + 16);
}

/** GIF：逻辑屏幕的宽高在偏移 6、8（小端 16 位）。 */
export function gifBytes(width: number, height: number): Buffer {
  return pad([...ascii('GIF89a'), ...le16(width), ...le16(height), 0, 0, 0], 32);
}

/** WebP 的三种子格式。 */
export function webpBytes(kind: 'VP8 ' | 'VP8L' | 'VP8X', width: number, height: number): Buffer {
  const riff = (chunk: number[]): number[] => [...ascii('RIFF'), ...be32(0), ...ascii('WEBP'), ...ascii(kind), ...be32(0), ...chunk];
  if (kind === 'VP8 ') return pad(riff([0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(width), ...le16(height)]), 48);
  if (kind === 'VP8L') {
    const bits = (width - 1) | ((height - 1) << 14);
    return pad(riff([0x2f, bits & 0xff, (bits >>> 8) & 0xff, (bits >>> 16) & 0xff, (bits >>> 24) & 0xff]), 48);
  }
  return pad(riff([0, 0, 0, 0, ...le24(width - 1), ...le24(height - 1)]), 48);
}
