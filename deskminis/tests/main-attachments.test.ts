/** MU2b Task 6：main 侧附件落盘纯函数（src/main/attachments.ts）——node 直测不启动 Electron。
 *  attachmentPath：sessionId UUID 正则校验（minisd 同款）防路径逃逸；
 *  decodeImageDataUrl：data:image/*;base64 解码，坏 dataUrl 拒绝。 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { attachmentPath, decodeImageDataUrl } from '../src/main/attachments';

const VALID_ID = 'A47184C8-77FA-4D88-9981-6BDE73C87C4E';

describe('MU2b Task 6 main 附件：attachmentPath + decodeImageDataUrl（3 例）', () => {
  it('attachmentPath：合法 UUID → <root>/sessions/<id>/attachments/paste-<ts>.png', () => {
    const p = attachmentPath('/data/root', VALID_ID, 1722440000000);
    expect(p).toBe(join('/data/root', 'sessions', VALID_ID, 'attachments', 'paste-1722440000000.png'));
    // 小写 UUID 同样放行（正则 i 旗标，与 minisd 同款）
    expect(attachmentPath('/r', VALID_ID.toLowerCase(), 1)).toContain('paste-1.png');
  });

  it('attachmentPath：非法 sessionId（路径穿越/非 UUID/空）一律拒绝', () => {
    expect(() => attachmentPath('/r', '../../Windows', 1)).toThrow('非法 sessionId');
    expect(() => attachmentPath('/r', 'not-a-uuid', 1)).toThrow('非法 sessionId');
    expect(() => attachmentPath('/r', '', 1)).toThrow('非法 sessionId');
    expect(() => attachmentPath('/r', VALID_ID + '/../../etc', 1)).toThrow('非法 sessionId');
  });

  it('decodeImageDataUrl：合法 png/jpg 解码出字节；坏 dataUrl 拒绝', () => {
    // 'PNGDATA' 的 base64
    expect(decodeImageDataUrl('data:image/png;base64,UE5HREFUQQ==').toString()).toBe('PNGDATA');
    expect(decodeImageDataUrl('data:image/jpeg;base64,UE5HREFUQQ==').toString()).toBe('PNGDATA');
    // 非 data: 前缀 / 非图片类型 / 空内容 → 拒绝
    expect(() => decodeImageDataUrl('hello world')).toThrow();
    expect(() => decodeImageDataUrl('data:text/html;base64,PGI+')).toThrow();
    expect(() => decodeImageDataUrl('')).toThrow();
  });
});
