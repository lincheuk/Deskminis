/**
 * F02 图片的 token 估算：读文件头取尺寸，按各服务商公布的公式换算。图片绝不按 base64 字符量冒充 token——
 * 一张 3 MB 的图 base64 有 400 万字符，按文本估是 100 万 token，实际计费只有几千。
 *
 * 出处（2026-10-03 读取；没有服务商计数接口可调，这些都是有来源的估计，不是精确值）：
 *  - Anthropic：platform.claude.com 的 vision 文档——⌈宽/28⌉ × ⌈高/28⌉；高分辨率档（4.7 及以后）长边缩到 2576、单张上限 4784，
 *    标准档长边 1568、上限 1568。认不出型号属于哪一档，统一按高分辨率档算（标准档只会更少，偏高只让减压更早）；
 *  - Gemini：ai.google.dev 的 image-understanding 文档——两边都 ≤ 384 计 258；更大的按裁剪单元切块、每块 258，
 *    裁剪单元约 floor(min(宽,高)/1.5)（文档例子：960×540 是 6 块 = 1548）。单元的上下限 [256, 768] 是本实现的设定，未核对；
 *  - OpenAI 兼容端点背后是很多家，没有统一规则：借用 28 px 网格公式并封顶 4784，标为 default（保守近似）。
 */
import type { RequestProtocol } from '../../shared/runtime-model';
import type { MediaEstimate } from '../../shared/request-budget';

/** 量尺寸只需要文件头。取 3 的倍数：base64 的前 87,380 个字符与文件的前 65,535 个字节解出同一段字节，
 *  循环（整张图的 base64）与上下文条（只读文件头）因此量出同一个尺寸。 */
export const IMAGE_HEADER_BYTES = 65_535;
const HEADER_BASE64_CHARS = IMAGE_HEADER_BYTES / 3 * 4;

export interface ImageSize { width: number; height: number }

const ANTHROPIC_MAX_EDGE = 2576;
const ANTHROPIC_MAX_TOKENS = 4784;
const GEMINI_TILE_TOKENS = 258;
/** 读不出尺寸时 Gemini 的保守近似：按 1568×1568（渲染端入库前把长边缩到 1568）算出的 9 块。 */
const GEMINI_DEFAULT_TOKENS = 2322;

const be16 = (b: Uint8Array, o: number): number => (b[o] << 8) | b[o + 1];
const be32 = (b: Uint8Array, o: number): number => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const le16 = (b: Uint8Array, o: number): number => b[o] | (b[o + 1] << 8);
const le24 = (b: Uint8Array, o: number): number => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
const tag = (b: Uint8Array, o: number, s: string): boolean => {
  if (o + s.length > b.length) return false;
  for (let i = 0; i < s.length; i++) if (b[o + i] !== s.charCodeAt(i)) return false;
  return true;
};
const sized = (width: number, height: number): ImageSize | undefined => width > 0 && height > 0 ? { width, height } : undefined;

function jpegSize(b: Uint8Array): ImageSize | undefined {
  let o = 2;
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff) return undefined;
    const marker = b[o + 1];
    if (marker === 0xff) { o += 1; continue; }                 // 填充字节
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { o += 2; continue; }   // 不带长度的标记
    if (marker === 0xd9 || marker === 0xda) return undefined;   // 到了图像数据还没见到 SOF
    const len = be16(b, o + 2);
    if (len < 2) return undefined;
    // SOF0–SOF15，其中 C4（霍夫曼表）、C8（保留）、CC（算术编码条件）不是帧头
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (o + 9 > b.length) return undefined;
      return sized(be16(b, o + 7), be16(b, o + 5));
    }
    o += 2 + len;
  }
  return undefined;
}

function webpSize(b: Uint8Array): ImageSize | undefined {
  if (tag(b, 12, 'VP8 ')) {
    // 有损：帧头 3 字节之后是起始码 9D 01 2A，再后面宽、高各 14 位
    if (b.length < 30 || b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return undefined;
    return sized(le16(b, 26) & 0x3fff, le16(b, 28) & 0x3fff);
  }
  if (tag(b, 12, 'VP8L')) {
    if (b.length < 25 || b[20] !== 0x2f) return undefined;
    const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
    return sized((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (tag(b, 12, 'VP8X')) {
    if (b.length < 30) return undefined;
    return sized(le24(b, 24) + 1, le24(b, 27) + 1);
  }
  return undefined;
}

/** 从文件头读宽高：PNG / JPEG / GIF / WebP。任何不符合预期的字节、宽或高为 0，都返回 undefined，不抛。 */
export function readImageSize(bytes: Uint8Array): ImageSize | undefined {
  const b = bytes;
  if (b.length >= 24 && b[0] === 0x89 && tag(b, 1, 'PNG') && tag(b, 12, 'IHDR')) return sized(be32(b, 16), be32(b, 20));
  if (b.length >= 10 && (tag(b, 0, 'GIF87a') || tag(b, 0, 'GIF89a'))) return sized(le16(b, 6), le16(b, 8));
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) return jpegSize(b);
  if (tag(b, 0, 'RIFF') && tag(b, 8, 'WEBP')) return webpSize(b);
  return undefined;
}

/** 从 base64 取尺寸：只解前 87,380 个字符（= 文件前 IMAGE_HEADER_BYTES 字节），不为量尺寸把整张图解一遍。 */
export function imageSizeFromBase64(base64: string): ImageSize | undefined {
  if (!base64) return undefined;
  try { return readImageSize(Buffer.from(base64.slice(0, HEADER_BASE64_CHARS), 'base64')); } catch { return undefined; }
}

/** 28 px 网格：等比缩到长边 ≤ 2576，⌈宽/28⌉ × ⌈高/28⌉，封顶 4784。 */
function gridTokens(size: ImageSize): number {
  const scale = Math.min(1, ANTHROPIC_MAX_EDGE / Math.max(size.width, size.height));
  return Math.min(ANTHROPIC_MAX_TOKENS, Math.ceil(size.width * scale / 28) * Math.ceil(size.height * scale / 28));
}

export function estimateImageTokens(protocol: RequestProtocol, size: ImageSize | undefined): MediaEstimate {
  if (protocol === 'anthropic') {
    return size ? { kind: 'image', tokens: gridTokens(size), basis: 'formula' } : { kind: 'image', tokens: ANTHROPIC_MAX_TOKENS, basis: 'upper-bound' };
  }
  if (protocol === 'gemini') {
    if (!size) return { kind: 'image', tokens: GEMINI_DEFAULT_TOKENS, basis: 'default' };
    if (size.width <= 384 && size.height <= 384) return { kind: 'image', tokens: GEMINI_TILE_TOKENS, basis: 'formula' };
    const unit = Math.min(768, Math.max(256, Math.floor(Math.min(size.width, size.height) / 1.5)));
    return { kind: 'image', tokens: GEMINI_TILE_TOKENS * Math.ceil(size.width / unit) * Math.ceil(size.height / unit), basis: 'formula' };
  }
  return { kind: 'image', tokens: size ? gridTokens(size) : ANTHROPIC_MAX_TOKENS, basis: 'default' };
}
