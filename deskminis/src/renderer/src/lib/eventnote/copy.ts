/** EventNote 文案层（MU2a Task 8，设计 v2 §5.3）：五类事件条的图标/短句/语调映射 +
 *  错误信息人话化。纯函数无 DOM，node 直测。 */

export type EventNoteTone = 'warn' | 'info' | 'err';

export interface EventCopy {
  icon: string; // Icon.vue 已有路径名（不新增图标）
  short: string; // 条内短句
  tone: EventNoteTone; // 色调 → --state-{warn|info|err}-bg/border 槽
}

/** 原始错误信息 → 一句人话：先剥 HTTP 状态码，再认网络层错误，剥不出截断 80 字。 */
export function humanizeError(raw: string): string {
  const msg = String(raw ?? '');
  if (/\b(401|403)\b/.test(msg)) return 'API Key 无效或过期';
  if (/\b429\b/.test(msg)) return '请求过频或额度不足';
  const m5 = /\b(5\d{2})\b/.exec(msg);
  if (m5) return `模型服务暂时不可用（${m5[1]}）`;
  if (/fetch failed/i.test(msg) || /\bENOTFOUND\b/.test(msg)) return '网络连接失败';
  const flat = msg.replace(/\s+/g, ' ').trim();
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
}

/** 五类事件条文案（短句对齐设计 §5.3）；error 短句由 humanizeError 从 detail 提炼。 */
export function eventCopy(kind: string, detail?: string): EventCopy {
  switch (kind) {
    case 'fallback': return { icon: 'alert', short: '已切换到备选模型', tone: 'warn' };
    case 'compacted': return { icon: 'refresh', short: '上下文已压缩', tone: 'info' };
    case 'offloaded': return { icon: 'folder', short: '大段输出已存入文件', tone: 'info' };
    case 'retry': return { icon: 'clock', short: '网络波动，正在重试', tone: 'warn' };
    case 'error': return { icon: 'alert', short: humanizeError(detail ?? ''), tone: 'err' };
    default: return { icon: 'info', short: detail ?? '', tone: 'info' };
  }
}
