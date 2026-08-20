/** 附件落盘纯函数（MU2b Task 6，main 侧 attachments:save handler 的可测核）。
 *  与 Electron 解耦，node 直测（tests/main-attachments.test.ts）。 */
import { join } from 'node:path';

/** 与 minisd/index.ts SESSION_ID_RE 同款：sessionId 拼进文件系统路径前必须限死 UUID 形态，
 *  否则 '../../Windows' 这类值会逃出数据根，在宿主任意目录落文件。 */
const SESSION_ID_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

/** 附件落盘绝对路径：<root>/sessions/<id>/attachments/paste-<ts>.<ext>（与 minisd paths.sessionBucket 同构）。
 *  F2a：ext 随降采样导出格式走（png/jpg/gif/webp 白名单）——jpeg 导出的字节落 .png 的话，
 *  mimeFromPath 会把 image/png 报给 provider 而实际字节是 jpeg，Anthropic 对 media_type
 *  与字节不符直接 400。缺省 png（旧调用/非降采样路径向后兼容）。 */
const EXT_WHITELIST = new Set(['png', 'jpg', 'gif', 'webp']);

export function attachmentPath(root: string, sessionId: string, ts: number, ext: string = 'png'): string {
  if (!SESSION_ID_RE.test(sessionId)) throw new Error('非法 sessionId');
  if (!EXT_WHITELIST.has(ext)) throw new Error('非法扩展名');
  return join(root, 'sessions', sessionId, 'attachments', `paste-${ts}.${ext}`);
}

/** dataUrl 的 mime → 落盘扩展名（jpeg/jpg 归一为 jpg）；非四类图片 mime 返回 undefined
 *  （decodeImageDataUrl 会随后拒绝，此处不另起第二套校验）。 */
export function extFromDataUrl(dataUrl: string): string | undefined {
  const m = /^data:image\/(png|jpe?g|gif|webp);base64,/.exec(dataUrl);
  if (!m) return undefined;
  return m[1].startsWith('jp') ? 'jpg' : m[1];
}

/** data:image/*;base64 解码为字节；非图片 dataUrl、坏 base64（解出空内容）一律拒绝。 */
export function decodeImageDataUrl(dataUrl: string): Buffer {
  const m = /^data:image\/(png|jpe?g|gif|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw new Error('非法图片 dataUrl');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length === 0) throw new Error('非法图片 dataUrl');
  return buf;
}
