/** MU2b Task 6：main 侧附件落盘纯函数（src/main/attachments.ts）——node 直测不启动 Electron。
 *  attachmentPath：sessionId UUID 正则校验（minisd 同款）防路径逃逸；
 *  decodeImageDataUrl：data:image/*;base64 解码，坏 dataUrl 拒绝。 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { attachmentPath, decodeImageDataUrl, extFromDataUrl } from '../src/main/attachments';

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

/** F2a：降采样后 jpeg/webp 导出的字节不能再一律落 .png——mimeFromPath 会把
 *  image/png 报给 provider 而实际字节是 jpeg（Anthropic 对 media_type 与字节
 *  不符会 400）。扩展名必须随 dataUrl 的 mime 走。 */
describe('F2a main 附件：扩展名随导出格式', () => {
  it('extFromDataUrl：四类 mime → png/jpg/gif/webp；未知 mime 拒绝（undefined）', () => {
    expect(extFromDataUrl('data:image/png;base64,UE5H')).toBe('png');
    expect(extFromDataUrl('data:image/jpeg;base64,UE5H')).toBe('jpg');
    expect(extFromDataUrl('data:image/gif;base64,UE5H')).toBe('gif');
    expect(extFromDataUrl('data:image/webp;base64,UE5H')).toBe('webp');
    expect(extFromDataUrl('data:image/bmp;base64,UE5H')).toBeUndefined();
    expect(extFromDataUrl('garbage')).toBeUndefined();
  });

  it('attachmentPath 带 ext：jpeg 导出落 paste-<ts>.jpg；缺省仍 .png（向后兼容）', () => {
    expect(attachmentPath('/r', VALID_ID, 1722440000000, 'jpg'))
      .toBe(join('/r', 'sessions', VALID_ID, 'attachments', 'paste-1722440000000.jpg'));
    expect(attachmentPath('/r', VALID_ID, 1)).toContain('paste-1.png');
    // ext 白名单外一律拒绝（防 'jpg/../../x' 之类借 ext 逃逸桶）
    expect(() => attachmentPath('/r', VALID_ID, 1, 'txt')).toThrow('非法扩展名');
    expect(() => attachmentPath('/r', VALID_ID, 1, '../png')).toThrow('非法扩展名');
    expect(() => attachmentPath('/r', VALID_ID, 1, '')).toThrow('非法扩展名');
  });
});
