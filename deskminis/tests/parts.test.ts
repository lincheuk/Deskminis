import { describe, it, expect } from 'vitest';
import { serializeParts, parseParts, mimeFromPath } from '../src/shared/parts';
import type { ContentPart } from '../src/shared/types';

describe('ContentPart 序列化', () => {
  it('text/toolUse/toolResult 往返一致', () => {
    const parts: ContentPart[] = [
      { type: 'text', value: '你好' },
      { type: 'toolUse', value: { toolUseId: 'T1', name: 'shell_execute', input: '{"command":"dir","tool_title":"列目录"}' } },
      { type: 'toolResult', value: { toolUseId: 'T1', output: 'ok', success: true, status: 'success' } },
    ];
    expect(parseParts(serializeParts(parts))).toEqual(parts);
  });
  it('未知 part 类型透传不丢', () => {
    const raw = '[{"type":"futurePart","value":{"x":1}}]';
    const round = serializeParts(parseParts(raw));
    expect(JSON.parse(round)).toEqual(JSON.parse(raw));
  });
  it('非法 JSON 抛错', () => {
    expect(() => parseParts('{oops')).toThrow();
  });
});

describe('mimeFromPath 四映射 + 未知扩展名', () => {
  it('png/jpg/jpeg/gif/webp → 对应 mimeType', () => {
    expect(mimeFromPath('attachments/paste-1.png')).toBe('image/png');
    expect(mimeFromPath('attachments/paste-1.jpg')).toBe('image/jpeg');
    expect(mimeFromPath('attachments/paste-1.jpeg')).toBe('image/jpeg');
    expect(mimeFromPath('attachments/paste-1.gif')).toBe('image/gif');
    expect(mimeFromPath('attachments/paste-1.webp')).toBe('image/webp');
  });
  it('大写扩展名与未知扩展名 → undefined（校验阶段已挡，这里只兜底）', () => {
    expect(mimeFromPath('attachments/a.PNG')).toBe('image/png'); // 大小写不敏感（校验正则带 i）
    expect(mimeFromPath('attachments/a.bmp')).toBeUndefined();
    expect(mimeFromPath('a.txt')).toBeUndefined();
    expect(mimeFromPath('无扩展名')).toBeUndefined();
  });
});
