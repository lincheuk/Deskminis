import { describe, it, expect } from 'vitest';
import { serializeParts, parseParts } from '../src/shared/parts';
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
