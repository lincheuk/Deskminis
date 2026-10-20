/** Q20b：事件 kind 的运行时全集与确定收尾，复用真实 store/RPC 桩。 */
import { expect } from 'vitest';
import { watch } from 'vue';
import { resetStoreRpc, initStore, dispatchStore, settleStore, openCalls, type Chat, type EventKind, type StoreRpcProbe } from './renderer-store-fixture';
import type { ContextRecoveryView } from '../src/shared/compaction';

export type EventNote = { kind: EventKind; ts: number; key?: string; detail?: string; retryable?: boolean; relay?: boolean; short?: string; retry?: { attempt: number; delayMs: number }; };

export function recoveryView(): ContextRecoveryView {
  return { v: 1, incident: 1, seq: 1, slot: { label: '主力', modelId: 'm' }, phase: 'failed', rejections: 1, resends: 0, runRejections: 1, before: { slot: '主力', inputTokens: 25000, inputLimit: 21000, maxTokens: 8192, status: 'ok' }, actions: [], limits: { resendsPerIncident: 2, rejectionsPerRun: 6 }, stop: 'noProgress' };
}

export const NOTE_CASES = {
  fallback: { from: 'base', to: 'next', reason: 'because' },
  compacted: { markerId: 'K', summary: 'summary' },
  offloaded: { toolUseId: 'T', relativePath: 'tools/result.txt' },
  retry: { attempt: 2, delayMs: 1500, reason: 'retry reason' },
  error: { message: 'ordinary error' },
  synced: { mergedCount: 3, fromDevice: 'abcdefZZ' },
  pruned: { count: 3 },
  compactFailed: { reason: 'malformed', message: 'compact error' },
  capability: { label: 'compat', notices: ['one', 'two'] },
  contextRecovery: { view: recoveryView() },
} satisfies Record<Chat['eventNotes'][number]['kind'], Record<string, unknown>>;

export async function fireNote(probe: StoreRpcProbe, chat: Chat, kind: EventKind): Promise<void> {
  const payload = kind === 'synced'
    ? { kind, sessionId: chat.activeId, ...NOTE_CASES[kind] }
    : { sessionId: chat.activeId, event: { kind, ...NOTE_CASES[kind] } };
  await dispatchStore(probe, 'chat.event', payload);
}

/** 联合全部十值逐个真实派发，RPC 逐方法、逐参数、逐次序核对。 */
export async function checkNoteKinds(probe: StoreRpcProbe): Promise<void> {
  const expectedDetails = { fallback: 'base → next（because）', compacted: '已压缩（摘要：summary…）', offloaded: '卸载工具输出 → tools/result.txt', retry: '第 2 次，2s 后', error: 'ordinary error', synced: '已同步 3 条来自 abcdef', pruned: '已修剪 3 条历史工具结果', compactFailed: 'compact error', capability: 'one\ntwo' };
  for (const kind of Object.keys(NOTE_CASES) as EventKind[]) {
    resetStoreRpc(probe);
    const chat = await initStore(probe);
    chat.activeId = 'A';
    await fireNote(probe, chat, kind);
    expect(chat.eventNotes).toHaveLength(1);
    expect(chat.eventNotes[0]).toMatchObject({ kind, ts: 10000 });
    if (kind !== 'contextRecovery')
      expect(chat.eventNotes[0].detail).toBe(expectedDetails[kind]);
    else
      expect(chat.eventNotes[0]).toMatchObject({ key: 'cr1', short: '同一模型上恢复不了' });
    const calls = kind === 'error' ? openCalls('A') : kind === 'synced' ? [['chat.sessions.list'], ['attachments.status', { sessionId: 'A' }]]
      : ['fallback', 'compacted', 'offloaded', 'pruned', 'contextRecovery'].includes(kind) ? [['chat.contextInfo', { sessionId: 'A' }]] : [];
    expect(probe.call.mock.calls, kind).toEqual(calls);
  }
}
/** 0/9/10/11 四个边界，每个 kind 都校验保留最后九条旧记录并追加新条。 */
export async function checkNoteCap(probe: StoreRpcProbe, kinds: readonly EventKind[]): Promise<void> {
  for (const kind of kinds)
    for (const n of [0, 9, 10, 11]) {
      resetStoreRpc(probe);
      const chat = await initStore(probe);
      chat.activeId = 'A';
      const old = Array.from({ length: n }, (_, i) => ({ kind: 'retry' as const, ts: i, detail: 'old-' + i }));
      chat.eventNotes = old;
      await fireNote(probe, chat, kind);
      expect(chat.eventNotes).toHaveLength(Math.min(n, 9) + 1);
      expect(chat.eventNotes.slice(0, -1)).toEqual(old.slice(-9));
      expect(chat.eventNotes.at(-1)?.kind).toBe(kind);
    }
}

export type RunOrigin = 'local' | 'joined' | 'idle';
export const RUN_ORIGINS = { local: true, joined: true, idle: true } satisfies Record<RunOrigin, true>;

/** 本窗口发起、中途接上、尚未看到运行：都经过实际 send 或 chat.event 入口准备。 */
export async function prepareRun(probe: StoreRpcProbe, origin: RunOrigin): Promise<Chat> {
  resetStoreRpc(probe);
  const chat = await initStore(probe);
  chat.activeId = 'A';
  if (origin === 'local') await chat.send('begin');
  if (origin === 'joined') await dispatchStore(probe, 'chat.event', { sessionId: 'A', event: { kind: 'textDelta', text: 'joined' } });
  expect([chat.running, chat.midRun]).toEqual(origin === 'local' ? [true, false] : origin === 'joined' ? [true, true] : [false, false]);
  probe.call.mockClear();
  return chat;
}

/** 非终止事件：三个运行来源 × 当前/其它会话 × 正文/思考四组合；同步观察所有禁止的写入。 */
export async function checkBranchStates(probe: StoreRpcProbe, kind: 'compactFailed' | 'fallback' | 'retry'): Promise<void> {
  for (const origin of Object.keys(RUN_ORIGINS) as RunOrigin[]) {
    for (const owner of ['A', 'B']) {
      for (const text of ['', 'old text']) {
        for (const thinking of ['', 'old thinking']) {
          const chat = await prepareRun(probe, origin);
          chat.streamingText = text;
          chat.streamingThinking = thinking;
          chat.lastError = 'old error';
          chat.retryNote = 'old retry';
          const old = [{ kind: 'retry' as const, ts: 1, detail: 'old note' }];
          chat.eventNotes = old;
          const wasRunning = chat.running;
          const wasMid = chat.midRun;
          const runningWrites: boolean[] = [];
          const errorWrites: string[] = [];
          const publish: unknown[] = [];
          const stops = [
            watch(() => chat.running, v => runningWrites.push(v), { flush: 'sync' }),
            watch(() => chat.lastError, v => errorWrites.push(v), { flush: 'sync' }),
            watch(() => chat.fallbackState, () => publish.push([chat.streamingText, chat.streamingThinking]), { flush: 'sync' }),
          ];
          try {
            const event = kind === 'compactFailed' ? { kind, reason: 'malformed', message: 'raw\ncompact detail' } : { kind, ...NOTE_CASES[kind] };
            await dispatchStore(probe, 'chat.event', { sessionId: owner, event });
            expect(errorWrites).toEqual([]);
            expect(chat.lastError).toBe('old error');
            expect(runningWrites).toEqual(owner === 'A' && origin === 'idle' ? [true] : []);
            expect(chat.running).toBe(owner === 'A' ? true : wasRunning);
            expect(chat.midRun).toBe(owner === 'A' ? origin !== 'local' : wasMid);
            const clears = owner === 'A' && kind !== 'compactFailed';
            expect([chat.streamingText, chat.streamingThinking]).toEqual(clears ? ['', ''] : [text, thinking]);
            expect(publish).toEqual(owner === 'A' && kind === 'fallback' ? [['', '']] : []);
            if (owner === 'B') {
              expect(chat.eventNotes).toEqual(old);
              expect(chat.retryNote).toBe('old retry');
            } else {
              expect(chat.eventNotes).toHaveLength(2);
              expect(chat.eventNotes[1].kind).toBe(kind);
              if (kind === 'compactFailed') {
                expect(chat.eventNotes[1]).toEqual({ kind, ts: 10000, detail: 'raw\ncompact detail' });
                expect(chat.eventNotes[1]).not.toHaveProperty('retryable');
              }
              expect(chat.retryNote).toBe(kind === 'retry' ? '正在重试…（第 2 次，2s 后）' : 'old retry');
            }
            expect(probe.call.mock.calls).toEqual(owner === 'A' && kind === 'fallback' ? [['chat.contextInfo', { sessionId: 'A' }]] : []);
          } finally {
            for (const stop of stops) stop();
          }
        }
      }
    }
  }
}

/** 终止事件先观察同步清理，再等历史请求完成；open() 的最终清理不能掩盖 midRun 分支。 */
export async function checkTerminalStates(probe: StoreRpcProbe, kind: 'error' | 'turnEnd'): Promise<void> {
  for (const origin of Object.keys(RUN_ORIGINS) as RunOrigin[]) {
    for (const owner of ['A', 'B']) {
      for (const text of ['', 'old text']) {
        for (const thinking of ['', 'old thinking']) {
          const chat = await prepareRun(probe, origin);
          chat.streamingText = text;
          chat.streamingThinking = thinking;
          chat.retryNote = 'old retry';
          chat.lastError = 'old error';
          const card = { toolUseId: 'T', name: 'read', title: 'old tool' };
          chat.toolCards = [card];
          const before = [chat.running, chat.midRun, text, thinking, 'old retry', 'old error'];
          const handler = probe.handlers.get('chat.event');
          expect(handler).toBeTypeOf('function');
          const dispatched = handler!({ sessionId: owner, event: kind === 'error' ? { kind, message: 'new error' } : { kind, stopReason: 'endTurn' } });
          if (owner === 'A') {
            expect([chat.running, chat.midRun, chat.streamingText, chat.streamingThinking, chat.retryNote, chat.lastError]).toEqual([false, false, origin === 'joined' ? '' : text, '', '', kind === 'error' ? 'new error' : 'old error']);
            expect(chat.toolCards).toEqual(origin === 'joined' ? [] : [card]);
          } else {
            expect([chat.running, chat.midRun, chat.streamingText, chat.streamingThinking, chat.retryNote, chat.lastError]).toEqual(before);
            expect(chat.toolCards).toEqual([card]);
          }
          await dispatched;
          await settleStore();
          if (owner === 'A') expect([chat.streamingText, chat.streamingThinking]).toEqual(['', '']);
          else expect(probe.call.mock.calls).toEqual([]);
        }
      }
    }
  }
}
