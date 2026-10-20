/** MU2b Task 2：进度 tab（ProgressPanel 替换 TasksPanel）——chat.ts 增量 + 视图 + App/ChatView 接线（源文本守卫）。
 *  Global Constraints 源文本守卫同步修订清单允许：本文件在同 Task 内整体改写为 ProgressPanel 守卫；
 *  M2d 语义回归锚（chat.ts 7 字段/open·send 清零/fetchContextInfo/三事件分支/turnEnd）原样保留。 */
/* T6e-3 集体退场说明：本文件有若干例随实现退场。理由——
   任务面板内部实现（toolStats 三计数、STOP_LABEL、retryNote 卡）——新树的 ui/TaskPanel.vue 只报上下文水位与回合状态，工具成败就地显示在对话流的 StepGroup 上。新落点：tests/renderer-shell-panels.test.ts（V5，含 StopReason 四值中文映射）。 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
const { _rpcCall, _rpcOn, _handlers, _rpcLost, _rpcConnect } = vi.hoisted(() => {
  const handlers = new Map<string, (params: any) => unknown>();
  return { _rpcCall: vi.fn(), _rpcOn: vi.fn((method: string, handler: (params: any) => unknown) => { handlers.set(method, handler); }), _handlers: handlers, _rpcLost: vi.fn(), _rpcConnect: vi.fn(async () => {}) };
});
vi.mock('../src/renderer/src/rpc', () => ({ rpc: { call: _rpcCall, on: _rpcOn, onLost: _rpcLost, connect: _rpcConnect } }));

import fs from 'node:fs';
import path from 'node:path';
import { useChat } from '../src/renderer/src/stores/chat';

import { resetStoreRpc, initStore, settleStore, deferred, openCalls, type Equal, type Chat, type EventKind, type ToolCard } from './renderer-store-fixture';
import { prepareRun, RUN_ORIGINS, type RunOrigin, checkTerminalStates, NOTE_CASES, checkNoteKinds, checkNoteCap, fireNote, type EventNote } from './renderer-store-events';

import type { ContextInfo } from '../src/shared/request-budget';

const root = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

const progressPanel = fs.readFileSync(path.join(root, 'src/renderer/src/ui/TaskPanel.vue'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src/renderer/src/ui/AppShell.vue'), 'utf8');
const chatView = fs.readFileSync(path.join(root, 'src/renderer/src/ui/StageChat.vue'), 'utf8');

const _probe = { call: _rpcCall, on: _rpcOn, handlers: _handlers, lost: _rpcLost, connect: _rpcConnect };
// 每例初始化真实 Pinia，记录桩；固定时钟用于事件 timestamp 与 deadline，不以墙钟上界判未发生。
beforeEach(() => {
  resetStoreRpc(_probe);
  vi.spyOn(Date, 'now').mockReturnValue(10000);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('MU2b Task 2 进度 tab（ProgressPanel 替换 TasksPanel，8 例）', () => {
  it('S1. chat.ts M2d state 回归锚（7 字段全保留）+ MU2b 纯增量：permFocusRequestId + toolCards 元素 startedAt/endedAt（步骤行 duration 数据源）', async () => {
    // 每个 state 的实际初值与精确类型；声明形状与运行时初值分别把关。
    const cardType: true = true as Equal<Chat['toolCards'], ToolCard[]>;
    const focusType: true = true as Equal<Chat['permFocusRequestId'], string | null>;
    type ExpectedInfo = { windowTokens: number; usedTokens: number; remaining: number; budget?: ContextInfo['budget']; live?: boolean; };
    const contextType: true = true as Equal<Chat['contextInfo'], null | ExpectedInfo>;
    const stopType: true = true as Equal<Chat['lastStopReason'], string>;
    const notesType: true = true as Equal<Chat['eventNotes'][number], EventNote>;
    const fallbackType: true = true as Equal<Chat['fallbackState'], null | { from: string; to: string; reason: string; }>;
    const compactedType: true = true as Equal<Chat['compactedState'], null | { markerId: string; summary: string; }>;
    const offloadedType: true = true as Equal<Chat['offloadedState'], null | { count: number; lastRelativePath?: string; }>;
    expect([cardType, focusType, contextType, stopType, notesType, fallbackType, compactedType, offloadedType]).toEqual([true, true, true, true, true, true, true, true]);
    const chat = useChat();
    expect(chat.lastStopReason).toBe('');
    expect(chat.eventNotes).toEqual([]);
    expect(chat.fallbackState).toBeNull();
    expect(chat.compactedState).toBeNull();
    expect(chat.offloadedState).toBeNull();
    expect(chat.contextInfo).toBeNull();
    expect(chat.permFocusRequestId).toBeNull();
    chat.permFocusRequestId = 'R';
    expect(chat.permFocusRequestId).toBe('R');
    chat.permFocusRequestId = null;
    expect(chat.permFocusRequestId).toBeNull();
    chat.activeId = 'A';
    await chat.fetchContextInfo();
    expect(chat.contextInfo).toEqual({ windowTokens: 64000, usedTokens: 100, remaining: 63900 });
    expect(_rpcCall.mock.calls).toEqual([['chat.contextInfo', { sessionId: 'A' }]]);
    // 真 toolStart/toolEnd 各记一次当前时间，结束只改同 toolUseId 的卡。
    chat.onEvent({ kind: 'toolStart', toolUseId: 'T', name: 'file_write', title: 'write', input: 'input' });
    expect(chat.toolCards[0]).toEqual({ toolUseId: 'T', name: 'file_write', title: 'write', input: 'input', startedAt: 10000 });
    vi.mocked(Date.now).mockReturnValue(12000);
    chat.onEvent({ kind: 'toolEnd', toolUseId: 'T', output: 'done', success: true });
    expect(chat.toolCards[0]).toEqual({ toolUseId: 'T', name: 'file_write', title: 'write', input: 'input', startedAt: 10000, endedAt: 12000, output: 'done', success: true });
  });

  it('S2. M2d 回归：open(id) 与 send(text) 首段清零追加 lastStopReason/eventNotes/fallback/compacted/offloaded/contextInfo（不丢 lastError/retryNote/running）', async () => {
    // open 的换/不换会话条件两值；非默认哨兵确保每个清零字段都能被看见。
    const chat = await initStore(_probe);
    chat.activeId = 'A';
    const fill = () => {
      chat.lastError = 'old';
      chat.running = true;
      chat.retryNote = 'old retry';
      chat.lastStopReason = 'maxTokens';
      chat.eventNotes = [{ kind: 'retry', ts: 1 }];
      chat.fallbackState = { from: 'x', to: 'y', reason: 'r' };
      chat.compactedState = { markerId: 'K', summary: 's' };
      chat.offloadedState = { count: 2, lastRelativePath: 'file' };
      chat.contextInfo = { windowTokens: 100, usedTokens: 80, remaining: 20 };
    };
    fill();
    await chat.open('B');
    expect([chat.lastError, chat.retryNote, chat.lastStopReason]).toEqual(['', '', '']);
    expect(chat.eventNotes).toEqual([]);
    expect([chat.fallbackState, chat.compactedState, chat.offloadedState, chat.contextInfo]).toEqual([null, null, null, null]);
    expect(chat.running).toBe(false);
    expect(_rpcCall.mock.calls).toEqual(openCalls('B'));
    fill();
    await chat.open('B');
    expect(chat.running).toBe(true);
    expect(chat.lastStopReason).toBe('maxTokens');
    expect(chat.contextInfo?.usedTokens).toBe(80);
    // send 在第一段同步清回合状态；contextInfo 是缓存，原发送断言没有要求清它。
    _rpcCall.mockClear();
    const prompt = deferred();
    _rpcCall.mockReturnValueOnce(prompt.promise);
    const sending = chat.send('next');
    expect([chat.lastError, chat.retryNote, chat.lastStopReason]).toEqual(['', '', '']);
    expect(chat.eventNotes).toEqual([]);
    expect([chat.fallbackState, chat.compactedState, chat.offloadedState]).toEqual([null, null, null]);
    expect(chat.contextInfo?.usedTokens).toBe(80);
    expect(chat.running).toBe(true);
    expect(_rpcCall.mock.calls).toEqual([['chat.prompt', { sessionId: 'B', text: 'next', attachments: [], promptId: expect.any(String) }]]);
    prompt.resolve({ ok: true });
    await sending;

    // 同一会话重取在闲置、本窗口发起、中途接上三种状态都保留错误、事件条和上下文缓存。
    for (const origin of Object.keys(RUN_ORIGINS) as RunOrigin[]) {
      const same = await prepareRun(_probe, origin);
      same.lastError = 'keep error';
      same.retryNote = 'keep retry';
      same.lastStopReason = 'maxTokens';
      same.eventNotes = [{ kind: 'retry', ts: 1, detail: 'keep note' }];
      same.fallbackState = { from: 'x', to: 'y', reason: 'keep' };
      same.compactedState = { markerId: 'K', summary: 'keep summary' };
      same.offloadedState = { count: 2, lastRelativePath: 'keep.txt' };
      same.contextInfo = { windowTokens: 100, usedTokens: 80, remaining: 20 };
      const before = [same.lastError, same.retryNote, same.lastStopReason, same.eventNotes, same.fallbackState, same.compactedState, same.offloadedState, same.contextInfo, same.running, same.midRun];
      await same.open('A');
      expect([same.lastError, same.retryNote, same.lastStopReason, same.eventNotes, same.fallbackState, same.compactedState, same.offloadedState, same.contextInfo, same.running, same.midRun]).toEqual(before);
      expect(_rpcCall.mock.calls).toEqual(openCalls('A'));
    }

    // 切去的会话本身是否在跑都不影响清缓存；运行态取目标会话自己的集合。
    for (const targetRunning of [false, true]) {
      const switched = await prepareRun(_probe, 'local');
      switched.runningSessions = targetRunning ? ['A', 'B'] : ['A'];
      switched.contextInfo = { windowTokens: 100, usedTokens: 80, remaining: 20 };
      await switched.open('B');
      expect(switched.contextInfo).toBeNull();
      expect([switched.running, switched.midRun]).toEqual([targetRunning, targetRunning]);
      expect(_rpcCall.mock.calls).toEqual(openCalls('B'));
    }

  });

  it('S3. M2d 回归：init 首次调 fetchContextInfo + actions 定义 async fetchContextInfo（chat.contextInfo 存 state，catch 不抛）', async () => {
    // init 真调用 fetchContextInfo 一次；完整初始 RPC 顺序与各参数。
    const chat = useChat();
    chat.activeId = 'A';
    const fetch = vi.spyOn(chat, 'fetchContextInfo');
    await chat.init();
    await settleStore();
    expect(fetch.mock.calls).toEqual([[]]);
    expect(_rpcCall.mock.calls).toEqual([
      ['chat.sessions.list'], ['provider.instances.list'], ['provider.getDefault'], ['modelgroup.list'], ['assistants.list'], ['skills.list', {}], ['control.status'], ['permission.getPreset'], ['skills.list', { sessionId: 'A' }], ['chat.contextInfo', { sessionId: 'A' }], ['chat.sessions.listRetained', {}],
    ]);
    expect(chat.contextInfo).toEqual({ windowTokens: 64000, usedTokens: 100, remaining: 63900 });
    // A 的应答挂住后切 B，等应答完成才证明没有写回；B 自己的值与失败缓存也核对。
    _rpcCall.mockClear();
    const gate = deferred();
    _rpcCall.mockReturnValueOnce(gate.promise);
    const stale = chat.fetchContextInfo();
    expect(_rpcCall.mock.calls).toEqual([['chat.contextInfo', { sessionId: 'A' }]]);
    chat.activeId = 'B';
    gate.resolve({ windowTokens: 64000, usedTokens: 999, remaining: 63001 });
    await stale;
    expect(chat.contextInfo?.usedTokens).toBe(100);
    _rpcCall.mockClear();
    _rpcCall.mockResolvedValueOnce({ windowTokens: 64000, usedTokens: 200, remaining: 63800 });
    await chat.fetchContextInfo();
    expect(_rpcCall.mock.calls).toEqual([['chat.contextInfo', { sessionId: 'B' }]]);
    expect(chat.contextInfo?.usedTokens).toBe(200);
    _rpcCall.mockRejectedValueOnce(new Error('context unavailable'));
    await expect(chat.fetchContextInfo()).resolves.toBeUndefined();
    expect(chat.contextInfo?.usedTokens).toBe(200);

    // 旧应答在切往其它会话或欢迎页后都丢弃；原缓存为空、有值两类均不写回。
    for (const origin of Object.keys(RUN_ORIGINS) as RunOrigin[]) {
      for (const destination of ['B', '']) {
        for (const cached of [null, { windowTokens: 100, usedTokens: 80, remaining: 20 }]) {
          const stale = await prepareRun(_probe, origin);
          stale.contextInfo = cached;
          const reply = deferred();
          _rpcCall.mockReturnValueOnce(reply.promise);
          const request = stale.fetchContextInfo();
          stale.activeId = destination;
          reply.resolve({ windowTokens: 100, usedTokens: 99, remaining: 1 });
          await request;
          expect(stale.contextInfo).toEqual(cached);
          expect(_rpcCall.mock.calls).toEqual([['chat.contextInfo', { sessionId: 'A' }]]);
        }
      }
    }

    // 请求失败在空/非空缓存以及三个运行来源中都不抛、不写错误、不动运行态。
    for (const origin of Object.keys(RUN_ORIGINS) as RunOrigin[]) {
      for (const cached of [null, { windowTokens: 100, usedTokens: 80, remaining: 20 }]) {
        const failing = await prepareRun(_probe, origin);
        failing.contextInfo = cached;
        failing.lastError = 'keep error';
        const before = [failing.running, failing.midRun, failing.lastError];
        _rpcCall.mockRejectedValueOnce(new Error('context unavailable'));
        await expect(failing.fetchContextInfo()).resolves.toBeUndefined();
        expect(failing.contextInfo).toEqual(cached);
        expect([failing.running, failing.midRun, failing.lastError]).toEqual(before);
        expect(_rpcCall.mock.calls).toEqual([['chat.contextInfo', { sessionId: 'A' }]]);
      }
    }

  });

  it('S4. M2d 回归：onEvent 三事件分支（fallback/compacted/offloaded）各调 fetchContextInfo；turnEnd 末尾也调；M2c skills 状态保留', async () => {
    // 各 kind 都真派发；具体三状态的每字段和水位请求各验证一次。
    await checkNoteKinds(_probe);
    resetStoreRpc(_probe);
    const chat = await initStore(_probe);
    chat.activeId = 'A';
    for (const kind of ['fallback', 'compacted', 'offloaded'] as const) {
      _rpcCall.mockClear();
      await fireNote(_probe, chat, kind);
      expect(_rpcCall.mock.calls).toEqual([['chat.contextInfo', { sessionId: 'A' }]]);
      if (kind === 'fallback')
        expect(chat.fallbackState).toEqual({ from: 'base', to: 'next', reason: 'because' });
      if (kind === 'compacted')
        expect(chat.compactedState).toEqual({ markerId: 'K', summary: 'summary' });
      if (kind === 'offloaded')
        expect(chat.offloadedState).toEqual({ count: 1, lastRelativePath: 'tools/result.txt' });
    }
    _rpcCall.mockClear();
    chat.onEvent({ kind: 'offloaded', toolUseId: 'T2', relativePath: 'tools/second.txt' });
    await settleStore();
    expect(chat.offloadedState).toEqual({ count: 2, lastRelativePath: 'tools/second.txt' });
    expect(_rpcCall.mock.calls).toEqual([['chat.contextInfo', { sessionId: 'A' }]]);
    await checkNoteCap(_probe, Object.keys(NOTE_CASES) as EventKind[]);
    // turnEnd 的 open 调用先发历史 RPC，再发水位 RPC；应答之后的余下 open 刷新都完成。
    resetStoreRpc(_probe);
    const ended = await initStore(_probe);
    ended.activeId = 'A';
    ended.onEvent({ kind: 'turnEnd', stopReason: 'endTurn' });
    expect(_rpcCall.mock.calls).toEqual([['chat.messages.list', { sessionId: 'A' }], ['chat.contextInfo', { sessionId: 'A' }]]);
    await settleStore();
    expect(_rpcCall.mock.calls).toEqual([['chat.messages.list', { sessionId: 'A' }], ['chat.contextInfo', { sessionId: 'A' }], ...openCalls('A').slice(1)]);
    // skills 的初值/声明与活动会话、无会话两个清单各真走。
    type Skill = { id: string; name: string; description: string; isEnabled: boolean; useCount: number; };
    const skillType: true = true as Equal<Chat['skills'], Skill[]>;
    expect(skillType).toBe(true);
    resetStoreRpc(_probe);
    const skills = useChat();
    expect(skills.skills).toEqual([]);
    const rows = [{ id: 'on', name: 'On', description: 'd', isEnabled: true, useCount: 1 }, { id: 'off', name: 'Off', description: 'd', isEnabled: false, useCount: 2 }];
    skills.activeId = 'A';
    _rpcCall.mockResolvedValueOnce(rows);
    await skills.refreshSkills();
    expect(_rpcCall.mock.calls).toEqual([['skills.list', { sessionId: 'A' }]]);
    expect(skills.skills).toEqual(rows);
    skills.activeId = '';
    _rpcCall.mockClear();
    _rpcCall.mockResolvedValueOnce(rows);
    await skills.refreshSkills();
    expect(_rpcCall.mock.calls).toEqual([['skills.list', {}]]);
    expect(skills.skills).toEqual([rows[0]]);

    // turnEnd 同步清思考；只有中途接上才在历史到达前清半截正文与步骤卡。
    await checkTerminalStates(_probe, 'turnEnd');
  });

  it('S5. 组件换代：TasksPanel.vue 已删除（existsSync === false）；App.vue 改 import ProgressPanel + visited.progress 挂载，TasksPanel 字样清零', () => {
    expect(fs.existsSync(path.join(root, 'src/renderer/src/components/TasksPanel.vue'))).toBe(false);
    // T6e-3：文件 / 改动 / 任务在新树里是 ui/WorkspacePanel.vue 的三个 tab，
// 不再是 App.vue 里三个并列面板——tab 切换断言随之落到面板内部。
    expect(read('src/renderer/src/ui/WorkspacePanel.vue')).toMatch(/import TaskPanel from '\.\/TaskPanel\.vue'/);
    // T6e-3 重指：任务是 WorkspacePanel 的第三个 tab
    expect(read('src/renderer/src/ui/WorkspacePanel.vue')).toMatch(/tab === 'tasks'/);
    expect(app).not.toContain("TasksPanel");
  });

  it('S7. 等待批准显著化（T6e-3 重指：呈现主体换人）', () => {
    // 旧模型：任务面板出一张「⏸ 等待批准」卡 + 工作台 tab 出橙点 + ChatView 滚动定位。
    // 新模型：权限卡**直接渲染在对话流里**（V1 补的那块，换壳时整个漏掉过），
    // 用户看见的就是卡本身，不需要另一个面板再提示一次、也不需要跨面板跳转。
    // 所以这里只钉「任务面板仍报得出回合状态」，权限卡本体由
    // tests/renderer-chat-capabilities.test.ts 与 tests/renderer-permcard.test.ts 守。
    expect(progressPanel).toMatch(/running|stopReason|等待/);
  });

});
