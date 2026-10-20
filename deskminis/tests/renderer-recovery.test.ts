/**
 * F03 渲染端：超窗恢复与压缩记录的呈现。文案层（lib/recovery/format.ts）是纯函数，直接表驱动；
 * store 真跑（pinia，rpc 用桩）；.vue 不在 typecheck 覆盖内，用源码守卫钉住接线（实拍见 work\verify\F03）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const { rpcCall } = vi.hoisted(() => ({ rpcCall: vi.fn() }));
vi.mock('../src/renderer/src/rpc', () => ({
  rpc: { call: rpcCall, connect: async () => {}, on: () => {}, off: () => {}, onLost: () => {} },
}));

// eslint-disable-next-line import/first —— vi.mock 由 vitest 提升到顶部，此处 import 拿到的是桩
import { createPinia, setActivePinia } from 'pinia';
import { watch } from 'vue';
// eslint-disable-next-line import/first
import { useChat } from '../src/renderer/src/stores/chat';
// eslint-disable-next-line import/first
import { eventCopy } from '../src/renderer/src/lib/eventnote/copy';
// eslint-disable-next-line import/first
import { limitNoteOf } from '../src/renderer/src/lib/budget/format';
// eslint-disable-next-line import/first
import {
  compactionLines, prunedDetail, readCompactionView, readRecoveryView, recoveryLines, recoveryShort,
} from '../src/renderer/src/lib/recovery/format';
// eslint-disable-next-line import/first
import type { CompactionView, ContextRecoveryView, RecoveryAction } from '../src/shared/compaction';
// eslint-disable-next-line import/first
import type { LimitProfile } from '../src/shared/request-budget';
// eslint-disable-next-line import/first
import { renderSfc, visibleText } from './sfc-setup';

const R = (p: string) => readFileSync(resolve(__dirname, p), 'utf8').replace(/\r\n/g, '\n');
const PANEL_FILE = resolve(__dirname, '../src/renderer/src/ui/TaskPanel.vue');
const notesVue = R('../src/renderer/src/ui/EventNotes.vue');
const panelVue = R('../src/renderer/src/ui/TaskPanel.vue');

let contextInfo: Record<string, unknown> = {};
beforeEach(() => {
  setActivePinia(createPinia());
  contextInfo = { windowTokens: 64_000, usedTokens: 1_000, remaining: 63_000 };
  rpcCall.mockReset();
  rpcCall.mockImplementation(async (method: string) => {
    if (method === 'chat.contextInfo') return contextInfo;
    if (method === 'chat.messages.list') return [];
    return { ok: true };
  });
});

afterEach(() => { vi.restoreAllMocks(); });

const brief = (inputTokens: number, maxTokens: number, status: 'ok' | 'tight' | 'over' = 'ok') =>
  ({ slot: '主力', inputTokens, inputLimit: 21_776, maxTokens, status });
const view = (phase: ContextRecoveryView['phase'], o: Partial<ContextRecoveryView> = {}): ContextRecoveryView => ({
  v: 1, incident: 1, seq: 1, slot: { label: '主力', modelId: 'm' }, phase, rejections: 1, resends: phase === 'failed' ? 0 : 1, runRejections: 1,
  before: brief(25_000, 8_192, 'ok'), actions: [{ kind: 'ceiling', basis: 'hint', total: 22_800 }],
  limits: { resendsPerIncident: 2, rejectionsPerRun: 6 }, ...o,
});
const compactDone: RecoveryAction = { kind: 'compact', result: 'done', markerId: 'K1', rule: 'recent-turns', messages: 10 };

describe('lib/recovery/format：短句', () => {
  it('resending 取最重的一档；recovered / switched / failed 各一句；runLimit 写明拒绝次数与上限', () => {
    expect(recoveryShort(view('resending'))).toBe('上下文超出模型上限：已调低本次输出上限后重发');
    expect(recoveryShort(view('resending', { actions: [{ kind: 'trim', level: 2, pruned: 3, clipped: 0 }] }))).toBe('上下文超出模型上限：已修剪旧工具结果后重发');
    expect(recoveryShort(view('resending', { actions: [{ kind: 'trim', level: 2, pruned: 3, clipped: 0 }, { kind: 'trim', level: 3, pruned: 3, clipped: 1 }] }))).toBe('上下文超出模型上限：已裁剪较大的工具结果后重发');
    expect(recoveryShort(view('resending', { actions: [{ kind: 'trim', level: 3, pruned: 0, clipped: 1 }, compactDone] }))).toBe('上下文超出模型上限：已压缩较早的对话后重发');
    // 压缩被跳过或失败不算「已压缩」
    expect(recoveryShort(view('resending', { actions: [{ kind: 'compact', result: 'failed', reason: 'malformed' }, { kind: 'trim', level: 3, pruned: 0, clipped: 2 }] }))).toBe('上下文超出模型上限：已裁剪较大的工具结果后重发');
    expect(recoveryShort(view('resending', { actions: [compactDone] }), { interrupted: true })).toBe('上下文超出模型上限：已压缩较早的对话后重发，这次重发没有完成');
    expect(recoveryShort(view('recovered', { resends: 2 }))).toBe('已在同一模型上恢复（重发 2 次）');
    expect(recoveryShort(view('switched', { switchedTo: '备用1' }))).toBe('同一模型上放不下，改用 备用1');
    expect(recoveryShort(view('failed', { stop: 'noProgress' }))).toBe('同一模型上恢复不了');
    expect(recoveryShort(view('failed', { stop: 'runLimit', runRejections: 7 }))).toBe('本次运行里端点已拒绝 7 次（上限 6 次），不再在同一模型上恢复');
  });

  it('U1 failed 停在本次运行的熔断上（压缩次数 / 摘要请求 / 摘要花费用完，或压缩已停用）：短句写明是哪一条，详情里逐条列出', () => {
    const skipped = (reason: string): RecoveryAction => ({ kind: 'compact', result: 'skipped', reason });
    const ceiling: RecoveryAction = { kind: 'ceiling', basis: 'hint', total: 18_988 };
    const failed = (reason: string) => view('failed', { stop: 'noProgress', actions: [ceiling, skipped(reason), skipped(reason)] });
    expect(recoveryShort(failed('limit'))).toBe('同一模型上恢复不了：本次运行的压缩次数已用完');
    expect(recoveryShort(failed('requests'))).toBe('同一模型上恢复不了：本次运行的摘要请求次数已用完');
    expect(recoveryShort(failed('spendCap'))).toBe('同一模型上恢复不了：本次运行的摘要花费已到上限');
    expect(recoveryShort(failed('disabled'))).toBe('同一模型上恢复不了：本次运行已停用压缩');
    // 这次确实没有可减的（没有可摘的、摘走的太少、摘完仍放不下）不是熔断：短句不变
    for (const reason of ['nothingToSummarize', 'tooSmall', 'wontFit']) expect(recoveryShort(failed(reason))).toBe('同一模型上恢复不了');
    expect(recoveryLines(failed('limit'))).toEqual([
      '主力 拒绝了这次请求（输入约 25,000、max_tokens 8,192）',
      '按端点报的数字，把上限记为输入加输出约 18,988',
      '没有压缩：本次运行的压缩次数已用完',
      '没有压缩：本次运行的压缩次数已用完',
      '能做的减压都做了，请求仍然放不下，没有再重发',
    ]);
  });

  it('详情：被拒的那次 → 每个动作 → 重发的那次 → 第几次重发 → 停在哪一条熔断', () => {
    const v = view('resending', {
      actions: [
        { kind: 'ceiling', basis: 'hint', total: 22_800 }, { kind: 'trim', level: 2, pruned: 4, clipped: 0 }, compactDone,
        { kind: 'compact', result: 'skipped', reason: 'wontFit' }, { kind: 'compact', result: 'failed', reason: 'truncated' },
        { kind: 'trim', level: 3, pruned: 4, clipped: 2 },
      ],
      after: brief(9_800, 8_192),
    });
    expect(recoveryLines(v)).toEqual([
      '主力 拒绝了这次请求（输入约 25,000、max_tokens 8,192）',
      '按端点报的数字，把上限记为输入加输出约 22,800',
      '修剪 4 条历史工具结果',
      '压缩了 10 条较早的消息（保留最近 3 个用户回合）',
      '没有压缩：摘要之后仍然放不下',
      '压缩失败：摘要被输出上限截断',
      '修剪 4 条历史工具结果，另裁剪 2 条较大的结果（保留头尾）',
      '重发的请求：输入约 9,800、max_tokens 8,192',
      '第 1 次重发，同一次超窗最多 2 次',
    ]);
    expect(recoveryLines(view('failed', { stop: 'noProgress', actions: [{ kind: 'ceiling', basis: 'step', input: 18_750, total: 26_942 }] }))).toEqual([
      '主力 拒绝了这次请求（输入约 25,000、max_tokens 8,192）',
      '端点没有报数字，把上限下调到输入约 18,750、输入加输出约 26,942',
      '能做的减压都做了，请求仍然放不下，没有再重发',
    ]);
    expect(recoveryLines(view('recovered', { actions: [{ kind: 'ceiling', basis: 'output-first', total: 104_512, output: 16_384 }], after: brief(40_000, 16_384) }))).toEqual([
      '主力 拒绝了这次请求（输入约 25,000、max_tokens 8,192）',
      '先调低输出：本次运行里这个模型最多申请 16,384 的输出',
      '被收下的请求：输入约 40,000、max_tokens 16,384',
      '第 1 次重发，同一次超窗最多 2 次',
    ]);
    expect(recoveryLines(view('switched', { stop: 'resendLimit', switchedTo: '备用1', resends: 2 })).slice(-3)).toEqual([
      '第 2 次重发，同一次超窗最多 2 次', '同一次超窗已重发到上限次数', '已改用 备用1',
    ]);
  });

  it('压缩卡的两行：覆盖与触发、保留项计数；没有佐证的陈述、文本形态各有说明；旧 marker 没有这两行', () => {
    const c: CompactionView = {
      markerId: 'K1', v: 2, form: 'structured', trigger: 'overflow', rule: 'recent-turns',
      coverage: { messages: 10, incrementMessages: 10, fromMessageId: 'a', toMessageId: 'b' },
      counts: { constraints: 2, todo: 3, done: 4, files: 5, userInstructions: 6, fileChanges: 7, runs: 1, unverified: 0 },
    };
    expect(compactionLines(c)).toEqual(['因端点拒绝，已摘要会话开头起的 10 条消息', '用户指示 6 条、文件变更 7 个、涉及文件 5 个、待办 3 条']);
    expect(compactionLines({ ...c, trigger: 'relief', counts: { ...c.counts!, unverified: 3 } })).toEqual([
      '因余量不足，已摘要会话开头起的 10 条消息', '用户指示 6 条、文件变更 7 个、涉及文件 5 个、待办 3 条；另有 3 条没有工具记录佐证的陈述没有写入摘要',
    ]);
    expect(compactionLines({ ...c, trigger: 'watermark', form: 'text' })).toEqual([
      '因水位，已摘要会话开头起的 10 条消息', '摘要模型没有按小节输出，目标与待办未结构化；用户指示 6 条、文件变更 7 个',
    ]);
    expect(compactionLines({ markerId: 'old', v: 1, createdAt: 1 })).toEqual([]);
  });

  it('读事件：形状不对的 view / detail 返回 null（旧引擎、坏数据不让界面崩）', () => {
    expect(readRecoveryView(view('resending'))).toEqual(view('resending'));
    expect(readRecoveryView(undefined)).toBeNull();
    expect(readRecoveryView({ ...view('resending'), phase: 'weird' })).toBeNull();
    expect(readRecoveryView({ ...view('resending'), before: { slot: 'x' } })).toBeNull();
    expect(readCompactionView({ markerId: 'K', v: 1 })).toEqual({ markerId: 'K', v: 1 });
    expect(readCompactionView({ v: 2 })).toBeNull();
    expect(readCompactionView(undefined)).toBeNull();
  });

  it('修剪的分级说明；没有 level 的事件文本不变', () => {
    expect(prunedDetail({ count: 4 })).toBe('已修剪 4 条历史工具结果');
    expect(prunedDetail({ count: 4, level: 2, clipped: 0 })).toBe('已修剪 4 条历史工具结果（含较新的结果）');
    expect(prunedDetail({ count: 4, level: 3, clipped: 2 })).toBe('已修剪 4 条历史工具结果，另裁剪 2 条较大的结果（保留头尾）');
  });

  it('limitNoteOf：端点在本次运行里拒绝过时，说明上限的来历与用途（不据此拒发）', () => {
    const l: LimitProfile = { kind: 'shared', inputLimit: 21_776, sharedWindow: 22_800, outputCap: 8_192, windowKnown: true, authority: 'advisory', basis: 'window', note: '', rejectedAt: 25_000 };
    expect(limitNoteOf(l)).toBe('输入上限 21,776；输入与输出共用 22,800 的窗口；端点在本次运行里拒绝过约 25,000 的输入，本次运行按这个上限提前减压与收紧输出，不据此拒发');
  });

  it('copy：contextRecovery → refresh 图标、warn 语调', () => {
    expect(eventCopy('contextRecovery')).toMatchObject({ icon: 'refresh', tone: 'warn' });
  });
});

describe('store：contextRecovery 事件', () => {
  it('决定重发时清掉流式缓冲、写状态；同一次事故的事件条就地替换，不重复追加', () => {
    const chat = useChat();
    chat.activeId = 'S1'; chat.running = true;
    chat.onEvent({ kind: 'textDelta', text: 'half of the rejected reply' });
    chat.onEvent({ kind: 'thinkingDelta', text: 'thinking' });
    chat.onEvent({ kind: 'pruned', count: 2 });
    chat.onEvent({ kind: 'contextRecovery', view: view('resending', { actions: [compactDone], after: brief(9_800, 8_192) }) });
    expect(chat.streamingText).toBe('');
    expect(chat.streamingThinking).toBe('');
    expect(chat.contextRecoveryState?.phase).toBe('resending');
    expect(chat.eventNotes.map(n => n.kind)).toEqual(['pruned', 'contextRecovery']);
    expect(chat.eventNotes[1]).toMatchObject({ key: 'cr1', short: '上下文超出模型上限：已压缩较早的对话后重发' });
    expect(chat.eventNotes[1].detail).toContain('重发的请求：输入约 9,800、max_tokens 8,192');

    chat.onEvent({ kind: 'textDelta', text: 'the real reply' });
    chat.onEvent({ kind: 'contextRecovery', view: view('recovered', { seq: 2, actions: [compactDone], after: brief(9_800, 8_192) }) });
    expect(chat.eventNotes.map(n => n.kind)).toEqual(['pruned', 'contextRecovery']);
    expect(chat.eventNotes[1].short).toBe('已在同一模型上恢复（重发 1 次）');
    // 端点已经收下重发的请求：正在流出的正文不清
    expect(chat.streamingText).toBe('the real reply');
    expect(chat.contextRecoveryState?.phase).toBe('recovered');
    // 另一次事故另占一条
    chat.onEvent({ kind: 'contextRecovery', view: view('resending', { incident: 2 }) });
    expect(chat.eventNotes.map(n => n.key)).toEqual([undefined, 'cr1', 'cr2']);
    // 形状不对的事件不动任何状态
    chat.onEvent({ kind: 'contextRecovery', view: { phase: 'resending' } });
    expect(chat.eventNotes).toHaveLength(3);
  });

  it('E3 重发没有完成：resending 之后来 error 或 turnEnd，恢复卡收起，那条事件条改说「这次重发没有完成」', () => {
    for (const end of [{ kind: 'error', message: '已取消' }, { kind: 'turnEnd', stopReason: 'endTurn' }]) {
      setActivePinia(createPinia());
      const chat = useChat();
      chat.activeId = 'S1'; chat.running = true;
      chat.onEvent({ kind: 'contextRecovery', view: view('resending', { actions: [{ kind: 'trim', level: 3, pruned: 0, clipped: 1 }] }) });
      chat.onEvent(end);
      expect(chat.contextRecoveryState).toBeNull();
      const note = chat.eventNotes.find(n => n.key === 'cr1')!;
      expect(note.short).toBe('上下文超出模型上限：已裁剪较大的工具结果后重发，这次重发没有完成');
    }
    // 终态（已恢复）之后的 turnEnd 不动它
    setActivePinia(createPinia());
    const chat = useChat();
    chat.activeId = 'S1'; chat.running = true;
    chat.onEvent({ kind: 'contextRecovery', view: view('recovered') });
    chat.onEvent({ kind: 'turnEnd', stopReason: 'endTurn' });
    expect(chat.contextRecoveryState?.phase).toBe('recovered');
    expect(chat.eventNotes.find(n => n.key === 'cr1')!.short).toBe('已在同一模型上恢复（重发 1 次）');
  });

  it('failed 自己成一条恢复说明，随后的 error 条照旧（带接力钮）；runLimit 的短句', () => {
    const chat = useChat();
    chat.activeId = 'S1'; chat.running = true;
    const failed = view('failed', { stop: 'runLimit', runRejections: 7, resends: 0 });
    chat.onEvent({ kind: 'contextRecovery', view: failed });
    chat.onEvent({ kind: 'error', code: 'contextFull', message: '上下文已满：当前模型放不下这段对话，可新建会话用摘要接力', relayDraft: 'draft', recovery: failed });
    expect(chat.eventNotes.map(n => n.kind)).toEqual(['contextRecovery', 'error']);
    expect(chat.eventNotes[0].short).toBe('本次运行里端点已拒绝 7 次（上限 6 次），不再在同一模型上恢复');
    expect(chat.eventNotes[1]).toMatchObject({ relay: true });
    // 终态的恢复说明留着，任务面板仍能解释这次失败
    expect(chat.contextRecoveryState?.phase).toBe('failed');
  });

  it('compacted 带 detail 时记下摘录；第 2、3 级修剪用分级说明，第 1 级文本不变；换会话时清零', async () => {
    const chat = useChat();
    chat.activeId = 'S1'; chat.running = true;
    const detail: CompactionView = { markerId: 'K1', v: 2, form: 'structured', trigger: 'overflow', rule: 'tight', coverage: { messages: 30, incrementMessages: 30, fromMessageId: 'a', toMessageId: 'b' } };
    chat.onEvent({ kind: 'compacted', markerId: 'K1', summary: '【目标】…', detail });
    expect(chat.compactedState).toEqual({ markerId: 'K1', summary: '【目标】…' });
    expect(chat.compactionDetail).toEqual(detail);
    chat.onEvent({ kind: 'compacted', markerId: 'K2', summary: 'old engine' });
    expect(chat.compactionDetail).toBeNull();
    chat.onEvent({ kind: 'pruned', count: 3 });
    chat.onEvent({ kind: 'pruned', count: 5, level: 3, clipped: 2 });
    expect(chat.eventNotes.slice(-2).map(n => n.detail)).toEqual(['已修剪 3 条历史工具结果', '已修剪 5 条历史工具结果，另裁剪 2 条较大的结果（保留头尾）']);
    chat.onEvent({ kind: 'contextRecovery', view: view('recovered') });
    await chat.open('S2');
    expect(chat.contextRecoveryState).toBeNull();
    expect(chat.compactionDetail).toBeNull();
  });

  it('fetchContextInfo：压缩记录的摘录来自库；停在「正在重发」的恢复说明在会话不在运行中时不显示', async () => {
    const chat = useChat();
    chat.activeId = 'S1';
    contextInfo = { ...contextInfo, compaction: { markerId: 'K9', v: 2, coverage: { messages: 12, incrementMessages: 12, fromMessageId: 'a', toMessageId: 'b' } }, recovery: view('resending') };
    await chat.fetchContextInfo();
    expect(chat.compactionDetail?.markerId).toBe('K9');
    expect(chat.contextRecoveryState).toBeNull();
    contextInfo = { ...contextInfo, recovery: view('failed', { stop: 'noProgress' }) };
    await chat.fetchContextInfo();
    expect(chat.contextRecoveryState?.phase).toBe('failed');
    // 摘录以应答为准：这个会话没有压缩记录时清掉
    contextInfo = { windowTokens: 64_000, usedTokens: 1_000, remaining: 63_000 };
    await chat.fetchContextInfo();
    expect(chat.compactionDetail).toBeNull();
  });

  /** chat.contextInfo 的应答由测试逐个放行：pending[i] 是第 i 次请求，resolve 时给出它的应答。 */
  function gatedContextInfo() {
    const pending: { sessionId: string; resolve: (info: Record<string, unknown>) => void }[] = [];
    rpcCall.mockImplementation((method: string, params?: { sessionId?: string }) => {
      if (method === 'chat.contextInfo') return new Promise(resolve => { pending.push({ sessionId: String(params?.sessionId), resolve }); });
      if (method === 'chat.messages.list') return Promise.resolve([]);
      return Promise.resolve({ ok: true });
    });
    return pending;
  }
  const infoOf = (used: number, extra: Record<string, unknown> = {}) => ({ windowTokens: 64_000, usedTokens: used, remaining: 64_000 - used, ...extra });
  const compactionOf = (markerId: string) => ({ markerId, v: 2, coverage: { messages: 12, incrementMessages: 12, fromMessageId: 'a', toMessageId: 'b' } });

  it('U2 会话 A 的 chat.contextInfo 在途时切到会话 B：晚到的应答整条丢弃，A 的恢复说明与压缩摘录不会挂到 B 上', async () => {
    const pending = gatedContextInfo();
    const chat = useChat();
    chat.activeId = 'A';
    const first = chat.fetchContextInfo();
    expect(pending.map(p => p.sessionId)).toEqual(['A']);
    await chat.open('B');
    expect(chat.activeId).toBe('B');
    // A 的应答这时才到：带着 A 上一次运行的终态恢复说明与 A 的压缩记录
    pending[0].resolve(infoOf(111, { recovery: view('failed', { stop: 'noProgress' }), compaction: compactionOf('KA') }));
    await first;
    expect(chat.contextRecoveryState).toBeNull();
    expect(chat.compactionDetail).toBeNull();
    expect(chat.contextInfo).toBeNull();
    // B 自己的应答（没有恢复说明、没有压缩记录）照常生效
    const own = chat.fetchContextInfo();
    expect(pending.at(-1)!.sessionId).toBe('B');
    pending.at(-1)!.resolve(infoOf(222));
    await own;
    expect(chat.contextInfo).toMatchObject({ usedTokens: 222 });
    expect(chat.contextRecoveryState).toBeNull();
    expect(chat.compactionDetail).toBeNull();
  });

  it('U3 同一会话里发新消息之前问的 chat.contextInfo 晚到：不把上一次运行的恢复说明写回刚清掉的状态；只收最新一次请求的应答', async () => {
    const pending = gatedContextInfo();
    const chat = useChat();
    chat.activeId = 'S1';
    chat.onEvent({ kind: 'contextRecovery', view: view('failed', { stop: 'noProgress' }) });
    const stale = pending.length;            // 上面那条事件触发的取数，下面再手动问一次：都是发送之前问的
    const before = chat.fetchContextInfo();
    const sent = chat.send('next message');
    expect(chat.contextRecoveryState).toBeNull();
    for (const p of pending.slice(0, stale + 1)) p.resolve(infoOf(111, { recovery: view('failed', { stop: 'noProgress' }), compaction: compactionOf('K-old') }));
    await before; await sent;
    expect(chat.contextRecoveryState).toBeNull();
    expect(chat.compactionDetail).toBeNull();
    // 发送之后问的两次：先问的那次后到也不生效（只收最新一次），最新一次的应答生效
    const older = chat.fetchContextInfo();
    const newer = chat.fetchContextInfo();
    const [o, n] = pending.slice(-2);
    n.resolve(infoOf(333, { compaction: compactionOf('K-new') }));
    await newer;
    o.resolve(infoOf(222, { recovery: view('recovered') }));
    await older;
    expect(chat.contextInfo).toMatchObject({ usedTokens: 333 });
    expect(chat.compactionDetail?.markerId).toBe('K-new');
    expect(chat.contextRecoveryState).toBeNull();
  });

  it('U4 重开会话 / 重启后没有 compacted 事件，只有 chat.contextInfo 带回的摘录：任务面板仍显示「上下文已压缩」卡与两行说明', async () => {
    const chat = useChat();
    chat.activeId = 'S1';
    // 没有压缩记录的会话：不出这张卡
    await chat.fetchContextInfo();
    expect(visibleText(await renderSfc(PANEL_FILE, {}))).not.toContain('上下文已压缩');
    contextInfo = {
      ...contextInfo,
      compaction: {
        markerId: 'K9', v: 2, form: 'structured', trigger: 'overflow', rule: 'recent-turns',
        coverage: { messages: 12, incrementMessages: 12, fromMessageId: 'a', toMessageId: 'b' },
        counts: { constraints: 2, todo: 3, done: 4, files: 5, userInstructions: 6, fileChanges: 7, runs: 1, unverified: 0 },
      },
    };
    await chat.fetchContextInfo();
    expect(chat.compactedState).toBeNull();
    let seen = visibleText(await renderSfc(PANEL_FILE, {}));
    expect(seen).toContain('上下文已压缩 早期消息已被摘要替换');
    expect(seen).toContain('因端点拒绝，已摘要会话开头起的 12 条消息');
    expect(seen).toContain('用户指示 6 条、文件变更 7 个、涉及文件 5 个、待办 3 条');
    // 本次运行里刚压缩：卡片正文是事件带的摘要开头，两行说明照旧
    chat.running = true;
    chat.onEvent({ kind: 'compacted', markerId: 'K10', summary: '【目标】整理文档', detail: contextInfo.compaction });
    seen = visibleText(await renderSfc(PANEL_FILE, {}));
    expect(seen).toContain('上下文已压缩 【目标】整理文档');
    expect(seen).not.toContain('早期消息已被摘要替换');
    expect(seen).toContain('因端点拒绝，已摘要会话开头起的 12 条消息');
    // 旧压缩记录（v1，没有覆盖与计数）：卡片在，没有那两行
    setActivePinia(createPinia());
    const old = useChat();
    old.activeId = 'S2';
    contextInfo = { windowTokens: 64_000, usedTokens: 1_000, remaining: 63_000, compaction: { markerId: 'K-old', v: 1, createdAt: 1 } };
    await old.fetchContextInfo();
    seen = visibleText(await renderSfc(PANEL_FILE, {}));
    expect(seen).toContain('上下文已压缩 早期消息已被摘要替换');
    expect(seen).not.toContain('已摘要会话开头起的');
  });

  it('U5 有压缩记录的会话里发一条新消息：「上下文已压缩」卡不消失（摘录是会话级的、来自库）；上一次运行的恢复说明与压缩事件摘要照旧清掉', async () => {
    const chat = useChat();
    chat.activeId = 'S1';
    contextInfo = {
      ...contextInfo,
      compaction: {
        markerId: 'K9', v: 2, form: 'structured', trigger: 'overflow', rule: 'recent-turns',
        coverage: { messages: 12, incrementMessages: 12, fromMessageId: 'a', toMessageId: 'b' },
        counts: { constraints: 2, todo: 3, done: 4, files: 5, userInstructions: 6, fileChanges: 7, runs: 1, unverified: 0 },
      },
    };
    // 上一次运行留下的状态：压缩过一次、在同一模型上恢复过；回合结束后任务面板取过 chat.contextInfo
    chat.running = true;
    chat.onEvent({ kind: 'compacted', markerId: 'K9', summary: '【目标】整理文档', detail: contextInfo.compaction });
    chat.onEvent({ kind: 'contextRecovery', view: view('recovered') });
    chat.running = false;
    await chat.fetchContextInfo();
    expect(visibleText(await renderSfc(PANEL_FILE, {}))).toContain('上下文已压缩 【目标】整理文档');

    rpcCall.mockClear();
    await chat.send('next message');
    // 发送本身不取 chat.contextInfo：卡片这一刻显示什么，全看 send() 留下了什么
    expect(rpcCall.mock.calls.map(c => c[0])).toEqual(['chat.prompt']);
    expect(chat.running).toBe(true);
    expect(chat.compactionDetail?.markerId).toBe('K9');
    expect(chat.compactedState).toBeNull();
    expect(chat.contextRecoveryState).toBeNull();
    let seen = visibleText(await renderSfc(PANEL_FILE, {}));
    expect(seen).toContain('上下文已压缩 早期消息已被摘要替换');
    expect(seen).toContain('因端点拒绝，已摘要会话开头起的 12 条消息');
    expect(seen).toContain('用户指示 6 条、文件变更 7 个、涉及文件 5 个、待办 3 条');
    expect(seen).not.toContain('上下文恢复');
    // 正文与工具卡事件也不触发取数：这段时间里卡片一直在
    chat.onEvent({ kind: 'textDelta', text: 'working on it' });
    chat.onEvent({ kind: 'toolStart', toolUseId: 'T1', name: 'file_read', input: '{}' });
    expect(rpcCall.mock.calls.map(c => c[0])).toEqual(['chat.prompt']);
    seen = visibleText(await renderSfc(PANEL_FILE, {}));
    expect(seen).toContain('上下文已压缩 早期消息已被摘要替换');
    expect(seen).toContain('因端点拒绝，已摘要会话开头起的 12 条消息');
    // 换会话照旧清掉：别的会话的压缩记录不会挂过来
    await chat.open('S2');
    expect(chat.compactionDetail).toBeNull();
  });
});

describe('源码守卫：接线', () => {
  const objectBody = (src: string, name: string): string => {
    const m = new RegExp(`const ${name}[^=]*= \\{([\\s\\S]*?)\\};`).exec(src);
    expect(m, `${name} 对象字面量`).not.toBeNull();
    return m![1];
  };
  it('EventNotes.vue：ICONS / TONES 都登记了 contextRecovery（漏登会退回 alert / info）', () => {
    expect(objectBody(notesVue, 'ICONS')).toMatch(/\bcontextRecovery: 'refresh'/);
    expect(objectBody(notesVue, 'TONES')).toMatch(/\bcontextRecovery: 'warn'/);
  });
  it('TaskPanel.vue：压缩卡多出的说明行与「上下文恢复」卡都来自 lib/recovery/format', () => {
    expect(panelVue).toContain("import { compactionLines, recoveryLines, recoveryShort } from '../lib/recovery/format';");
    expect(panelVue).toMatch(/<section v-if="chat\.contextRecoveryState" class="blk" data-recovery="card">/);
    expect(panelVue).toContain('{{ recoveryShort(chat.contextRecoveryState) }}');
    expect(panelVue).toMatch(/v-for="\(line, i\) in recoveryLines\(chat\.contextRecoveryState\)"/);
    expect(panelVue).toMatch(/v-for="\(line, i\) in compactionNotes"/);
    expect(panelVue).toContain('compactionLines(chat.compactionDetail)');
  });
  it('chat.ts：换会话、删除会话两处清零语句的末尾都追加了两个新状态；send() 只清恢复说明、不清压缩摘录；turnEnd / error 分支各调一次 settleStuckRecovery', async () => {
    // 四处会话级清零各走真实入口；生命周期的两个删除 kind 都走，卡片先放非空哨兵。
    const detail: CompactionView = { markerId: 'K-guard', v: 1, createdAt: 42 };
    for (const route of ['open', 'delete', 'deleted', 'tombstone-applied', 'snapshot'] as const) {
      setActivePinia(createPinia());
      const chat = useChat();
      chat.activeId = 'A';
      chat.contextRecoveryState = view('failed');
      chat.compactionDetail = detail;
      rpcCall.mockReset();
      rpcCall.mockImplementation(async (method: string) => {
        if (method === 'chat.sessions.list' || method === 'chat.sessions.listRetained' || method === 'chat.messages.list' || method === 'skills.list' || method === 'chat.annotations.list') return [];
        return { ok: true };
      });
      if (route === 'open') await chat.open('B');
      else if (route === 'delete') await chat.deleteSession('A');
      else if (route === 'snapshot') {
        chat.applySnapshot({
          epoch: 1, instanceId: 'guard', revision: 1, lastSeq: 1, takenAt: 42,
          sessions: [], runs: [], executions: [], live: [], pendingPermissions: [], artifacts: [],
          session: { sessionId: 'A', exists: false, messages: [] },
        }, { reason: 'no-cursor', cause: 'initial', epochChanged: false });
      } else {
        await chat.onSessionLifecycle({ sessionId: 'A', kind: route, v: 1, origin: 'remote', byDevice: 'peer-A' });
      }
      expect(chat.activeId, route).toBe(route === 'open' ? 'B' : '');
      expect(chat.contextRecoveryState, route).toBeNull();
      expect(chat.compactionDetail, route).toBeNull();
      const calls = rpcCall.mock.calls;
      if (route === 'delete') expect(calls).toEqual([['chat.sessions.delete', { sessionId: 'A', confirm: true }], ['chat.sessions.list']]);
      else if (route === 'snapshot') expect(calls).toEqual([]);
      else if (route !== 'open') expect(calls).toEqual([['chat.sessions.list'], ['chat.sessions.listRetained', {}]]);
      else expect(calls).toEqual([
        ['chat.messages.list', { sessionId: 'B' }], ['skills.list', { sessionId: 'B' }],
        ['chat.annotations.list', { sessionId: 'B' }], ['attachments.status', { sessionId: 'B' }], ['workspace.get', { sessionId: 'B' }],
      ]);
    }

    // 同一会话刷新不能误清会话级卡片；open 的换会话条件两边都实际走到。
    setActivePinia(createPinia());
    const same = useChat();
    same.activeId = 'same';
    same.contextRecoveryState = view('failed');
    same.compactionDetail = detail;
    await same.open('same');
    expect(same.contextRecoveryState).toEqual(view('failed'));
    expect(same.compactionDetail).toEqual(detail);

    // send 真发带附件的 prompt：同步清恢复说明、保留摘录，旧 contextInfo 应答放行后也不能写回。
    setActivePinia(createPinia());
    const chat = useChat();
    chat.activeId = 'S-send';
    chat.contextRecoveryState = view('failed');
    chat.compactionDetail = detail;
    let releaseInfo!: (info: Record<string, unknown>) => void;
    let stateAtPrompt: unknown;
    rpcCall.mockReset();
    rpcCall.mockImplementation((method: string) => {
      if (method === 'chat.contextInfo') return new Promise(resolve => { releaseInfo = resolve; });
      if (method === 'chat.prompt') stateAtPrompt = { recovery: chat.contextRecoveryState, compaction: chat.compactionDetail };
      return Promise.resolve({ ok: true });
    });
    // 同步观察能抓到先清成 null 又恢复的瞬态，不能只看结束时的值。
    const compactionWrites: unknown[] = [];
    const stopCompaction = watch(() => chat.compactionDetail, value => compactionWrites.push(value), { flush: 'sync' });
    try {
      const stale = chat.fetchContextInfo();
      const sending = chat.send('guard next', ['attachments/guard.txt']);
      expect(stateAtPrompt).toEqual({ recovery: null, compaction: detail });
      await expect(sending).resolves.toBeUndefined();
      expect(rpcCall.mock.calls).toEqual([
        ['chat.contextInfo', { sessionId: 'S-send' }],
        ['chat.prompt', { sessionId: 'S-send', text: 'guard next', attachments: ['attachments/guard.txt'], promptId: expect.stringMatching(/^[A-Za-z0-9._:-]{1,128}$/) }],
      ]);
      releaseInfo({ windowTokens: 64000, usedTokens: 123, recovery: view('failed'), compaction: { markerId: 'K-stale', v: 1 } });
      await stale;
      expect(chat.contextInfo).toBeNull();
      expect(chat.contextRecoveryState).toBeNull();
      expect(chat.compactionDetail).toEqual(detail);
      expect(compactionWrites).toEqual([]);
    } finally {
      stopCompaction();
    }

    // 两种结束事件各调用真实 settle 恰好一次、无实参；四种恢复 phase 全枚举。
    rpcCall.mockImplementation(async (method: string) => {
      if (method === 'chat.messages.list' || method === 'skills.list' || method === 'chat.annotations.list') return [];
      if (method === 'chat.contextInfo') return contextInfo;
      return { ok: true };
    });
    const phases = { resending: true, recovered: true, switched: true, failed: true } satisfies Record<ContextRecoveryView['phase'], true>;
    for (const kind of ['turnEnd', 'error'] as const) {
      for (const phase of Object.keys(phases) as ContextRecoveryView['phase'][]) {
        setActivePinia(createPinia());
        const ended = useChat();
        ended.activeId = 'S-end';
        ended.contextRecoveryState = view(phase);
        ended.eventNotes = [{ kind: 'contextRecovery', key: 'cr1', ts: 1, short: 'before' }];
        const settle = vi.spyOn(ended, 'settleStuckRecovery');
        ended.onEvent(kind === 'turnEnd' ? { kind, stopReason: 'endTurn' } : { kind, message: 'guard error' });
        expect(settle.mock.calls, kind + '/' + phase).toEqual([[]]);
        expect(settle.mock.contexts[0]).toBe(ended);
        expect(ended.contextRecoveryState, kind + '/' + phase).toEqual(phase === 'resending' ? null : view(phase));
        expect(ended.eventNotes.find(n => n.key === 'cr1')?.short).toBe(phase === 'resending' ? recoveryShort(view(phase), { interrupted: true }) : 'before');
        await new Promise<void>(resolve => setImmediate(resolve));
        settle.mockRestore();
      }
    }
  });
});
