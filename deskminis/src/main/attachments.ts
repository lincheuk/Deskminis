/** 附件落盘纯函数（MU2b Task 6，main 侧 attachments:save handler 的可测核）。
 *  与 Electron 解耦，node 直测（tests/main-attachments.test.ts）。 */
import { join } from 'node:path';

/** 与 minisd/index.ts SESSION_ID_RE 同款：sessionId 拼进文件系统路径前必须限死 UUID 形态，
 *  否则 '../../Windows' 这类值会逃出数据根，在宿主任意目录落文件。 */
const SESSION_ID_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

/** 附件落盘绝对路径：<root>/sessions/<id>/attachments/paste-<ts>.png（与 minisd paths.sessionBucket 同构）。 */
export function attachmentPath(root: string, sessionId: string, ts: number): string {
  if (!SESSION_ID_RE.test(sessionId)) throw new Error('非法 sessionId');
  return join(root, 'sessions', sessionId, 'attachments', `paste-${ts}.png`);
}

/** data:image/*;base64 解码为字节；非图片 dataUrl、坏 base64（解出空内容）一律拒绝。 */
export function decodeImageDataUrl(dataUrl: string): Buffer {
  const m = /^data:image\/(png|jpe?g|gif|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw new Error('非法图片 dataUrl');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length === 0) throw new Error('非法图片 dataUrl');
  return buf;
}
