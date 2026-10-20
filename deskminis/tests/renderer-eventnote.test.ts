/** MU2a Task 8：EventNote 五类事件统一语法 + 错误治理（设计 §5.3/§4.2/§1.3）。
 *  纯模块 lib/eventnote/copy.ts（6 例）+ EventNote/ChatView/chat.ts 源文本守卫（4 例）。
 *  守卫工具：源文本读取统一归一化 CRLF→LF。 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
const { _rpcCall, _rpcOn, _handlers, _rpcLost, _rpcConnect } = vi.hoisted(() => {
  const handlers = new Map<string, (params: any) => unknown>();
  return { _rpcCall: vi.fn(), _rpcOn: vi.fn((method: string, handler: (params: any) => unknown) => { handlers.set(method, handler); }), _handlers: handlers, _rpcLost: vi.fn(), _rpcConnect: vi.fn(async () => {}) };
});
vi.mock('../src/renderer/src/rpc', () => ({ rpc: { call: _rpcCall, on: _rpcOn, onLost: _rpcLost, connect: _rpcConnect } }));

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { eventCopy, humanizeError } from '../src/renderer/src/lib/eventnote/copy';

import { resetStoreRpc, initStore, settleStore, openCalls, type Equal, type Chat } from './renderer-store-fixture';
import { checkTerminalStates, checkNoteKinds, checkNoteCap, type EventNote } from './renderer-store-events';
import type { LoopEvent } from '../src/minisd/agent/loop';

const R = (p: string) => readFileSync(resolve(__dirname, p), 'utf8').replace(/\r\n/g, '\n');
const eventNote = R('../src/renderer/src/ui/EventNotes.vue');
const chatView = R('../src/renderer/src/ui/StageChat.vue');

const _probe = { call: _rpcCall, on: _rpcOn, handlers: _handlers, lost: _rpcLost, connect: _rpcConnect };
// 每例初始化真实 Pinia，记录桩；固定时钟用于事件 timestamp 与 deadline，不以墙钟上界判未发生。
beforeEach(() => {
  resetStoreRpc(_probe);
  vi.spyOn(Date, 'now').mockReturnValue(10000);
});
afterEach(() => { vi.restoreAllMocks(); });

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
  it('EventNotes：五类都有图标与语调 + 详情可折叠 + 可重试项给重试钮 + 无写死 color-mix 比例', () => {
    // 换壳后从「单条 props 组件」变成「读 store 的列表组件」，props 契约不再存在；
    // 锚的是**同一批不变量**：每类事件说得出话、详情不丢、能重试的给得出入口。
    expect(eventNote).toMatch(/ICONS/);
    expect(eventNote).toMatch(/TONES/);
    expect(eventNote).toMatch(/<details/);        // 详情折叠
    expect(eventNote).toMatch(/retry/);           // 重试
    expect(eventNote).not.toMatch(/color-mix\(in srgb, var\(--[a-z-]+\) \d+%/); // 比例走令牌不写死
  });

  it('StageChat：错误条退场，五类统一走 EventNotes；重试接线 chat.retryLast', () => {
    expect(chatView).toMatch(/import EventNotes from '\.\/EventNotes\.vue'/);
    expect(chatView).toMatch(/<EventNotes/);
    expect(chatView).not.toMatch(/class="errbar"/);   // 旧的单独错误条不许回魂
    // 重试钮在 EventNotes 里（组件化后接线也跟着搬）
    expect(eventNote).toMatch(/chat\.retryLast/);
  });

  it('chat.ts：retryLast 方法 + eventNotes kind 扩 retry/error + retry 分支流转 + error 分支 retryable 入条', async () => {
    // 编译期比较完整事件条声明；运行时十种 kind 全集由 satisfies 加实际派发保证。
    const noteType: true = true as Equal<Chat['eventNotes'][number], EventNote>;
    expect(noteType).toBe(true);
    await checkNoteKinds(_probe);
    // retryLast 真调用 send，取最后一条用户正文；没有送达的记录则沿用文本、附件和 promptId。
    resetStoreRpc(_probe);
    const chat = await initStore(_probe);
    chat.activeId = 'A';
    chat.messages = [{ id: 'old', role: 'user', parts: [{ type: 'text', value: 'old' }] }, { id: 'asst', role: 'assistant', parts: [] }, { id: 'last', role: 'user', parts: [{ type: 'text', value: 'saved' }, { type: 'text', value: 'second' }] }];
    await chat.retryLast();
    expect(_rpcCall.mock.calls).toEqual([['chat.prompt', { sessionId: 'A', text: 'saved\nsecond', attachments: [], promptId: expect.stringMatching(/^[A-Za-z0-9._:-]{1,128}$/) }]]);
    chat.undelivered = { sessionId: 'A', promptId: 'known-id', text: 'und text', attachments: ['attachments/a.png'], optimisticId: 'local-und' };
    _rpcCall.mockClear();
    await chat.retryLast();
    expect(_rpcCall.mock.calls).toEqual([['chat.prompt', { sessionId: 'A', text: 'und text', attachments: ['attachments/a.png'], promptId: 'known-id' }]]);
    // 五个错误码及无 code 的普通错误逐个走；不借 outputLimit 的 true 让其它分支恒绿。
    type Code = NonNullable<Extract<LoopEvent, { kind: 'error'; }>['code']>;
    const codes = {
      contextFull: { retryable: false, short: '上下文已满，当前模型放不下这段对话', relay: true },
      thinkingBinding: { retryable: false, short: 'Claude 拒绝回放历史思考块，请新建会话继续' },
      capability: { retryable: false, short: '没有能处理这条消息的模型，未发送' },
      requestBudget: { retryable: false, short: '请求放不下：系统提示与工具定义占满了模型的输入上限' },
      outputLimit: { retryable: true, short: '输出被 max_tokens 截断，没有产出正文' },
    } satisfies Record<Code, { retryable: boolean; short: string; relay?: boolean; }>;
    for (const code of [...Object.keys(codes), undefined] as (Code | undefined)[]) {
      resetStoreRpc(_probe);
      const failed = await initStore(_probe);
      failed.activeId = 'A';
      failed.running = true;
      failed.onEvent({ kind: 'error', code, message: 'raw 503 details', relayDraft: 'relay draft' });
      expect(failed.lastError).toBe('raw 503 details');
      expect(failed.running).toBe(false);
      expect(failed.eventNotes.at(-1)).toEqual({ kind: 'error', ts: 10000, detail: 'raw 503 details', ...(code ? codes[code] : { retryable: true }) });
      await settleStore();
      expect(_rpcCall.mock.calls).toEqual(openCalls('A'));
    }

    // 终止事件的清缓冲按本窗口发起、中途接上、未跟踪及其它会话分别观察。
    await checkTerminalStates(_probe, 'error');
  });

  it('chat.ts：lastError/retryNote 字段保留（双写过渡期，MU2b Task 2 收口）；send 清零路径不回归', async () => {
    // 状态类型、初值及真实事件双写；清零只检查动作本来负责的字段。
    const errorType: true = true as Equal<Chat['lastError'], string>;
    const retryType: true = true as Equal<Chat['retryNote'], string>;
    expect([errorType, retryType]).toEqual([true, true]);
    const chat = await initStore(_probe);
    expect(chat.lastError).toBe('');
    expect(chat.retryNote).toBe('');
    chat.activeId = 'A';
    chat.onEvent({ kind: 'retry', attempt: 2, delayMs: 1500 });
    expect(chat.retryNote).toBe('正在重试…（第 2 次，2s 后）');
    expect(chat.eventNotes.at(-1)).toEqual({ kind: 'retry', ts: 10000, detail: '第 2 次，2s 后', retry: { attempt: 2, delayMs: 1500 } });
    chat.lastError = 'previous error';
    _rpcCall.mockClear();
    await chat.send('next');
    expect(chat.lastError).toBe('');
    expect(chat.retryNote).toBe('');
    expect(chat.eventNotes).toEqual([]);
    expect(_rpcCall.mock.calls).toEqual([['chat.prompt', { sessionId: 'A', text: 'next', attachments: [], promptId: expect.any(String) }]]);
    chat.lastError = 'error A';
    chat.retryNote = 'retry A';
    _rpcCall.mockClear();
    await chat.open('B');
    expect(chat.lastError).toBe('');
    expect(chat.retryNote).toBe('');
    expect(_rpcCall.mock.calls).toEqual(openCalls('B'));
    chat.lastError = 'error B';
    chat.retryNote = 'retry B';
    await chat.open('B');
    expect(chat.lastError).toBe('error B');
    expect(chat.retryNote).toBe('retry B');
  });

  it('chat.ts：pruned 事件 → eventNotes 提示「已修剪 N 条历史工具结果」（守卫修剪接线）', async () => {
    // 编译期比较完整事件条声明；运行时十种 kind 全集由 satisfies 加实际派发保证。
    const noteType: true = true as Equal<Chat['eventNotes'][number], EventNote>;
    expect(noteType).toBe(true);
    await checkNoteKinds(_probe);
    // pruned 的两种 level 与旧形态都逐个真走，零计数也不能借别分支的中文通过。
    type Level = NonNullable<Extract<LoopEvent, { kind: 'pruned'; }>['level']>;
    const levels = { 2: true, 3: true } satisfies Record<Level, true>;
    for (const level of [...Object.keys(levels).map(Number), undefined])
      for (const count of [0, 3])
        for (const clipped of [0, 2]) {
          resetStoreRpc(_probe);
          const chat = await initStore(_probe);
          chat.activeId = 'A';
          chat.onEvent({ kind: 'pruned', count, level, clipped });
          expect(chat.eventNotes.at(-1)).toEqual({ kind: 'pruned', ts: 10000, detail: level === 2 || level === 3 ? clipped > 0 ? '已修剪 ' + count + ' 条历史工具结果，另裁剪 ' + clipped + ' 条较大的结果（保留头尾）' : '已修剪 ' + count + ' 条历史工具结果（含较新的结果）' : '已修剪 ' + count + ' 条历史工具结果' });
          await settleStore();
          expect(_rpcCall.mock.calls).toEqual([['chat.contextInfo', { sessionId: 'A' }]]);
        }
    await checkNoteCap(_probe, ['pruned']);
  });
});
