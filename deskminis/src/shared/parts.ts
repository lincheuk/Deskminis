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

/** 附件路径 → mimeType（png/jpg/jpeg/gif/webp 四类映射；未知扩展名返回 undefined）。
 *  后端 chat.prompt 落 mediaRef part 与前端乐观消息同构渲染共用这一份——
 *  各写一份必然漂移，chip 显示与请求编码的 media_type 会渐渐对不上。 */
export function mimeFromPath(p: string): string | undefined {
  const ext = /[.]([a-z0-9]+)$/i.exec(p)?.[1]?.toLowerCase();
  switch (ext) {
    case 'png': return 'image/png';
    case 'jpg': case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    default: return undefined;
  }
}
