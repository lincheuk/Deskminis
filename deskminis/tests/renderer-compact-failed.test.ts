/** W2a-1 渲染端 compactFailed 的呈现（设计稿 §3 第 4 条：eventNotes kind 联合在末尾追加 'compactFailed'）。
 *  .vue 不在 typecheck 覆盖内，先用源码守卫钉住接线；实拍与溢出提示条同组件，放在 W2a-6 一起做。
 *  守卫认调用形态（分支条件、push 进 eventNotes 的对象字面量、ICONS/TONES 对象里的键），不认散文里的裸字符串。 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
const { _rpcCall, _rpcOn, _handlers, _rpcLost, _rpcConnect } = vi.hoisted(() => {
  const handlers = new Map<string, (params: any) => unknown>();
  return { _rpcCall: vi.fn(), _rpcOn: vi.fn((method: string, handler: (params: any) => unknown) => { handlers.set(method, handler); }), _handlers: handlers, _rpcLost: vi.fn(), _rpcConnect: vi.fn(async () => {}) };
});
vi.mock('../src/renderer/src/rpc', () => ({ rpc: { call: _rpcCall, on: _rpcOn, onLost: _rpcLost, connect: _rpcConnect } }));

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { eventCopy } from '../src/renderer/src/lib/eventnote/copy';

import { watch } from 'vue';
import { resetStoreRpc, initStore, settleStore, type Equal, type Chat } from './renderer-store-fixture';
import { checkBranchStates, checkNoteKinds, type EventNote } from './renderer-store-events';

const R = (p: string) => readFileSync(resolve(__dirname, p), 'utf8').replace(/\r\n/g, '\n');

const notesVue = R('../src/renderer/src/ui/EventNotes.vue');

/** 取 `const NAME ... = { ... };` 对象字面量的正文，只在这个范围里认键。 */
function objectBody(src: string, name: string): string {
  const m = new RegExp(`const ${name}[^=]*= \\{([\\s\\S]*?)\\};`).exec(src);
  expect(m, `${name} 对象字面量`).not.toBeNull();
  return m![1];
}

const _probe = { call: _rpcCall, on: _rpcOn, handlers: _handlers, lost: _rpcLost, connect: _rpcConnect };
// 每例初始化真实 Pinia，记录桩；固定时钟用于事件 timestamp 与 deadline，不以墙钟上界判未发生。
beforeEach(() => {
  resetStoreRpc(_probe);
  vi.spyOn(Date, 'now').mockReturnValue(10000);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('W2a-1 compactFailed 渲染接线', () => {
  it('chat.ts：kind 联合在末尾追加 compactFailed（renderer-eventnote 的子串守卫靠前缀不变）', async () => {
    // 编译期比较完整事件条声明；运行时十种 kind 全集由 satisfies 加实际派发保证。
    const noteType: true = true as Equal<Chat['eventNotes'][number], EventNote>;
    expect(noteType).toBe(true);
    await checkNoteKinds(_probe);
  });

  it('chat.ts：onEvent 的 compactFailed 分支把 message 原样放进 detail，不给重试钮、不动 running', async () => {
    // compactFailed 的原消息、timestamp、十条封顶，且每个布尔运行态都保留。
    for (const running of [true, false])
      for (const n of [0, 9, 10, 11]) {
        resetStoreRpc(_probe);
        const chat = await initStore(_probe);
        chat.activeId = 'A';
        chat.running = running;
        chat.lastError = 'old error';
        chat.onEvent({ kind: 'textDelta', text: 'prefix' });
        const old = Array.from({ length: n }, (_, i) => ({ kind: 'retry' as const, ts: i, detail: 'old-' + i }));
        chat.eventNotes = old;
        const writes: string[] = [];
        const stopRun = watch(() => chat.running, () => writes.push('running'), { flush: 'sync' });
        const stopError = watch(() => chat.lastError, () => writes.push('lastError'), { flush: 'sync' });
        try {
          chat.onEvent({ kind: 'compactFailed', reason: 'malformed', message: 'raw\ncompact detail' });
          await settleStore();
          expect(chat.running).toBe(running);
          expect(chat.lastError).toBe('old error');
          expect(writes).toEqual([]);
          expect(chat.streamingText).toBe('prefix');
          expect(chat.eventNotes).toEqual([...old.slice(-9), { kind: 'compactFailed', ts: 10000, detail: 'raw\ncompact detail' }]);
          expect(chat.eventNotes.at(-1)).not.toHaveProperty('retryable');
          expect(_rpcCall.mock.calls).toEqual([]);
        } finally {
          stopRun();
          stopError();
        }
      }

    // 真实订阅入口补齐 midRun、其它会话及所有缓冲有无组合。
    await checkBranchStates(_probe, 'compactFailed');
  });

  it('copy：compactFailed → alert 图标、warn 语调、短句「上下文压缩失败，本轮按原样继续」', () => {
    expect(eventCopy('compactFailed', '摘要为空：…')).toEqual({ icon: 'alert', short: '上下文压缩失败，本轮按原样继续', tone: 'warn' });
  });

  it('EventNotes.vue：ICONS / TONES 都登记了 compactFailed（漏登会退回 alert/info，警告条显示成普通提示）', () => {
    expect(objectBody(notesVue, 'ICONS')).toMatch(/\bcompactFailed: 'alert'/);
    expect(objectBody(notesVue, 'TONES')).toMatch(/\bcompactFailed: 'warn'/);
  });
});
