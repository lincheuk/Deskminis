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
  // 401 先于 403：两者都可能是「key 问题」但处置相反——401 换 key，403 多数查余额/权限，
  // 合并成一句会误导聚合端点（如 nodetect）的欠费用户去白白换 key。
  if (/\b401\b/.test(msg)) return 'API Key 无效或过期';
  if (/\b403\b/.test(msg)) {
    if (/余额|欠费|额度|balance|quota|credit|insufficient/i.test(msg)) return '余额不足或额度受限（403）';
    return '访问被拒绝（403）：检查 Key 权限或账户余额';
  }
  if (/\b429\b/.test(msg)) return '请求过频或额度不足';
  // W2a-6：超窗文案必须排在 5xx 之前——「上下文已满（已用 512 / 200000）」、带 token 数的原始 400 报文里
  // 常有独立的三位数，先跑 5xx 正则会被说成「模型服务暂时不可用（512）」。带 code 的事件不会走到这里
  // （短句由 errorShortByCode 按 code 给），这条兜的是没带 code 的旧形态报文
  if (/上下文已满|context[_ ]length[_ ]exceeded|prompt is too long|maximum context length/i.test(msg)) return '上下文已满';
  const m5 = /\b(5\d{2})\b/.exec(msg);
  if (m5) return `模型服务暂时不可用（${m5[1]}）`;
  if (/fetch failed/i.test(msg) || /\bENOTFOUND\b/.test(msg)) return '网络连接失败';
  const flat = msg.replace(/\s+/g, ' ').trim();
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
}

/**
 * 带分类码的错误事件的短句（W2a-6 · 设计稿 §3 第 5 条）：先按 code 选，不对原始报文跑状态码正则。
 * 为什么不能交给 humanizeError：绑定错误的 message 是「中文说明 +（原始错误：…400 响应体）」，
 * 响应体里只要有一个独立的 5xx 三位数，就会被说成「模型服务暂时不可用」——与真正的原因南辕北辙。
 * 没有对应短句的 code 返回 undefined，调用方退回 humanizeError。
 */
export function errorShortByCode(code: unknown): string | undefined {
  if (code === 'contextFull') return '上下文已满，当前模型放不下这段对话';
  if (code === 'thinkingBinding') return 'Claude 拒绝回放历史思考块，请新建会话继续';
  return undefined;
}

/**
 * 降级事件的短句（W2a-6 · 设计稿 §3 第 2 条）：因超窗降级到更大窗口时写明改用了谁——换的是窗口更大、
 * 往往也更贵的模型，而且回合跑通后会话会改绑过去，用户得知道。其它原因的降级返回 undefined，仍用通用短句。
 */
export function fallbackShortByCause(cause: unknown, to: string): string | undefined {
  return cause === 'contextOverflow' ? `因上下文已满改用 ${to}` : undefined;
}

/** 五类事件条文案（短句对齐设计 §5.3）；error 短句由 humanizeError 从 detail 提炼。 */
export function eventCopy(kind: string, detail?: string): EventCopy {
  switch (kind) {
    case 'fallback': return { icon: 'alert', short: '已切换到备选模型', tone: 'warn' };
    case 'compacted': return { icon: 'refresh', short: '上下文已压缩', tone: 'info' };
    case 'offloaded': return { icon: 'folder', short: '大段输出已存入文件', tone: 'info' };
    case 'pruned': return { icon: 'info', short: '已修剪旧工具结果', tone: 'info' };
    // W2a-1：压缩失败只是没减压、回合照常进行，所以是 warn 不是 err；原因（为空/截断/拒绝/请求失败）在详情里
    case 'compactFailed': return { icon: 'alert', short: '上下文压缩失败，本轮按原样继续', tone: 'warn' };
    case 'retry': return { icon: 'clock', short: '网络波动，正在重试', tone: 'warn' };
    case 'error': return { icon: 'alert', short: humanizeError(detail ?? ''), tone: 'err' };
    default: return { icon: 'info', short: detail ?? '', tone: 'info' };
  }
}
