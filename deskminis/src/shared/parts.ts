import type { ContentPart } from './types';

export function serializeParts(parts: ContentPart[]): string {
  return JSON.stringify(parts);
}

export function parseParts(json: string): ContentPart[] {
  const arr = JSON.parse(json);
  if (!Array.isArray(arr)) throw new Error('parts_json 不是数组');
  for (const p of arr) {
    if (typeof p !== 'object' || p === null || typeof (p as { type?: unknown }).type !== 'string' || !('value' in p)) {
      throw new Error('非法 ContentPart: ' + JSON.stringify(p));
    }
  }
  return arr as ContentPart[];
}
