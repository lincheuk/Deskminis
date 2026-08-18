/** MU2a Task 8：EventNote 五类事件统一语法 + 错误治理（设计 §5.3/§4.2/§1.3）。
 *  纯模块 lib/eventnote/copy.ts（6 例）+ EventNote/ChatView/chat.ts 源文本守卫（4 例）。
 *  守卫工具：源文本读取统一归一化 CRLF→LF。 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { eventCopy, humanizeError } from '../src/renderer/src/lib/eventnote/copy';

const R = (p: string) => readFileSync(resolve(__dirname, p), 'utf8').replace(/\r\n/g, '\n');
const eventNote = R('../src/renderer/src/components/EventNote.vue');
const chatView = R('../src/renderer/src/components/ChatView.vue');
const chatTs = R('../src/renderer/src/stores/chat.ts');

describe('MU2a Task 8 eventCopy/humanizeError（6 例）', () => {
  it('五类短句映射：fallback/compacted/offloaded/retry 固定短句 + 图标 + tone', () => {
    expect(eventCopy('fallback', 'grok-4.5 → grok-3（429）')).toEqual({ icon: 'alert', short: '已切换到备选模型', tone: 'warn' });
    expect(eventCopy('compacted', '已压缩').tone).toBe('info');
    expect(eventCopy('compacted').short).toBe('上下文已压缩');
    expect(eventCopy('offloaded').short).toBe('大段输出已存入文件');
    expect(eventCopy('offloaded').tone).toBe('info');
    expect(eventCopy('retry').short).toBe('网络波动，正在重试');
    expect(eventCopy('retry').tone).toBe('warn');
    // 未知 kind 兜底：info 语调、detail 原样作短句
    expect(eventCopy('mystery', 'x').tone).toBe('info');
  });

  it('error：short 走 humanizeError，tone=err，图标 alert', () => {
    const c = eventCopy('error', 'HTTP 503 Service Unavailable');
    expect(c.tone).toBe('err');
    expect(c.icon).toBe('alert');
    expect(c.short).toBe('模型服务暂时不可用（503）');
  });

  it('humanizeError：401 → API Key 无效或过期；裸 403 → 访问被拒绝（403 细分后不再与 401 合并）', () => {
    expect(humanizeError('Request failed with status code 401')).toBe('API Key 无效或过期');
    expect(humanizeError('HTTP 403 Forbidden')).toBe('访问被拒绝（403）：检查 Key 权限或账户余额');
  });

  it('humanizeError：429 → 请求过频或额度不足', () => {
    expect(humanizeError('HTTP 429 Too Many Requests')).toBe('请求过频或额度不足');
    expect(humanizeError('rate_limit exceeded (429)')).toBe('请求过频或额度不足');
  });

  it('humanizeError：5xx → 模型服务暂时不可用（xxx）；fetch failed / ENOTFOUND → 网络连接失败', () => {
    expect(humanizeError('HTTP 500 Internal Server Error')).toBe('模型服务暂时不可用（500）');
    expect(humanizeError('Error: 502 Bad Gateway')).toBe('模型服务暂时不可用（502）');
    expect(humanizeError('TypeError: fetch failed')).toBe('网络连接失败');
    expect(humanizeError('getaddrinfo ENOTFOUND api.example.com')).toBe('网络连接失败');
  });

  it('humanizeError：剥不出模式 → 空白折叠后截断 80 字', () => {
    expect(humanizeError('模型返回了奇怪的东东')).toBe('模型返回了奇怪的东东');
    const long = 'x'.repeat(120);
    const out = humanizeError(long);
    expect(out.length).toBeLessThanOrEqual(81); // 80 + 省略号
    expect(out.startsWith('x'.repeat(80))).toBe(true);
    // 多行/多空白折叠成单行
    expect(humanizeError('line1\n\n  line2')).toBe('line1 line2');
  });

  it('pruned：info 语调 + 修剪短句（修剪事件是「零成本减压」提示，不打扰）', () => {
    const c = eventCopy('pruned', '已修剪 2 条历史工具结果');
    expect(c.tone).toBe('info');
    expect(c.short).toContain('修剪');
  });
});

describe('MU2a Task 8 守卫（4 例）', () => {
  it('EventNote.vue：props 契约（kind/icon/short/tone/detail?/retryable?）+ 详情折叠锚 + 重试钮锚 + 状态槽（无写死 color-mix 百分比）', () => {
    expect(eventNote).toContain('kind: string');
    expect(eventNote).toContain('icon: string');
    expect(eventNote).toContain('short: string');
    expect(eventNote).toContain('tone:');
    expect(eventNote).toContain('detail?: string');
    expect(eventNote).toContain('retryable?: boolean');
    expect(eventNote).toContain('<details');
    expect(eventNote).toContain('重试');
    expect(eventNote).toContain("emit('retry')");
    expect(eventNote).toContain('var(--state-warn-bg)');
    expect(eventNote).toContain('var(--state-info-bg)');
    expect(eventNote).toContain('var(--state-err-bg)');
    expect(eventNote).toContain('var(--state-warn-border)');
    expect(eventNote).toContain('var(--state-err-border)');
    expect(eventNote).not.toContain('color-mix'); // 百分比收进 tokens 槽，组件不写死
  });

  it('ChatView：errbar/eclose/retry 行退场；五类统一 <EventNote；重试接线 chat.retryLast', () => {
    expect(chatView).not.toContain('errbar');
    expect(chatView).not.toContain('eclose');
    expect(chatView).not.toContain('class="retry"');
    expect(chatView).toContain('<EventNote');
    expect(chatView).toContain("import EventNote from './EventNote.vue'");
    expect(chatView).toContain('eventCopy(');
    expect(chatView).toContain('chat.retryLast()');
    expect(chatView).not.toContain('class="evnote"'); // 旧内联条样式块随组件化退场
  });

  it('chat.ts：retryLast 方法 + eventNotes kind 扩 retry/error + retry 分支流转 + error 分支 retryable 入条', () => {
    expect(chatTs).toContain('retryLast');
    expect(chatTs).toContain("'fallback'|'compacted'|'offloaded'|'retry'|'error'");
    expect(chatTs).toContain('retryable?: boolean');
    // retry 事件双写：retryNote 保留（TasksPanel 引用）+ eventNotes 流转一条 kind retry
    expect(chatTs).toMatch(/e\.kind === 'retry'[\s\S]*?this\.retryNote = [\s\S]*?kind: 'retry'/);
    // error 事件：lastError 保留 + eventNotes 入 kind error + retryable: true
    expect(chatTs).toMatch(/e\.kind === 'error'[\s\S]*?kind: 'error'[\s\S]*?retryable: true/);
  });

  it('chat.ts：lastError/retryNote 字段保留（双写过渡期，MU2b Task 2 收口）；send 清零路径不回归', () => {
    expect(chatTs).toContain("lastError: '' as string");
    expect(chatTs).toContain("retryNote: '' as string");
    // send 前清零仍含 lastError/retryNote/eventNotes（既有行为不动）。
    // 签名随附件任务扩为 send(text, attachments?)——守卫只锚清零行为，不锚参数个数
    expect(chatTs).toMatch(/async send\(text: string, attachments\?: string\[\]\)[\s\S]*?this\.lastError = ''[\s\S]*?this\.eventNotes = \[\]/);
    // open 换会话清零仍含 lastError/retryNote
    expect(chatTs).toMatch(/if \(id !== this\.activeId\) \{[\s\S]*?this\.lastError = ''; this\.retryNote = ''/);
  });

  it('chat.ts：pruned 事件 → eventNotes 提示「已修剪 N 条历史工具结果」（守卫修剪接线）', () => {
    expect(chatTs).toContain("'fallback'|'compacted'|'offloaded'|'retry'|'error'|'synced'|'pruned'");
    expect(chatTs).toMatch(/e\.kind === 'pruned'[\s\S]*?已修剪[\s\S]*?条历史工具结果/);
  });
});
