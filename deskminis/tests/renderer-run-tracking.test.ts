/**
 * W2b-1 · 按会话跟踪运行状态（止血设计稿 §2「渲染端」与 §4 W2b-1；侦察 renderer.md「W2b-runset」与
 * open_questions 第 8 条；cross.md S19a）。
 *
 * 旧实现的两处假话：
 *   ① chat.event 处理器只把当前会话的事件交给 onEvent，别的会话的事件整条丢掉——渲染端根本不知道谁在跑；
 *   ② open() 换会话时无条件 running=false。会话 A 跑着切到 B 再切回 A，停止键没了、发送键亮着，
 *      按下去撞后端「该会话正在运行中」；流式区从切回那一刻的句子中间接着往下长。
 *
 * 本文件钉：非当前会话的事件也维护 runningSessions；切回仍在跑的会话 running=true 且 midRun=true，
 * 切到空闲会话 midRun 清零；send() 发起的回合从不算 midRun；
 * turnEnd / error 移出集合并清 midRun（顺手丢掉切回后接上的半截缓冲）；send() 被拒不残留；
 * StageChat 在 midRun 时只显示占位，不渲染半截的思考 / 步骤 / 正文。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// ── 桩掉 renderer 的 rpc：call 走可控实现，on 把处理器收进 handlers，测试里直接派发广播 ──
const { rpcCallMock, handlers } = vi.hoisted(() => ({
  rpcCallMock: vi.fn(),
  handlers: new Map<string, (p: any) => void>(),
}));

vi.mock('../src/renderer/src/rpc', () => ({
  rpc: {
    call: rpcCallMock,
    connect: async () => {},
    on: (method: string, h: (p: any) => void) => { handlers.set(method, h); },
  },
}));

// eslint-disable-next-line import/first —— vi.mock 由 vitest 提升到顶部，此处 import 拿到的是桩
import { createPinia, setActivePinia } from 'pinia';
// eslint-disable-next-line import/first
import { useChat } from '../src/renderer/src/stores/chat';

const root = path.resolve(__dirname, '..');

/** promptFails：true 用固定文案拒绝，字符串则用该文案拒绝（模拟后端「该会话正在运行中」等同步拒绝）。
 *  history：chat.messages.list 返回一条带文本的用户消息，给 retryLast() 找得到可重发的内容。 */
type StubOpts = { promptFails?: boolean | string; history?: boolean };

function stubRpc(opts: StubOpts = {}): void {
  rpcCallMock.mockImplementation(async (method: string) => {
    if (method === 'permission.getPreset') return { preset: 'ask' };
    if (method === 'chat.sessions.list') return [{ id: 'A', title: 'A' }, { id: 'B', title: 'B' }];
    if (method === 'provider.instances.list') return [];
    if (method === 'provider.getDefault') return {};
    if (method === 'modelgroup.list') return [];
    if (method === 'assistants.list') return [];
    if (method === 'skills.list') return [];
    if (method === 'control.status') return { syncPaused: false };
    if (method === 'chat.messages.list') {
      return opts.history ? [{ id: 'u1', role: 'user', parts: [{ type: 'text', value: '上一条' }], createdAt: 1 }] : [];
    }
    if (method === 'chat.annotations.list') return { annotations: [] };
    if (method === 'workspace.get') return { root: '/w', isDefault: true };
    if (method === 'chat.prompt') {
      if (opts.promptFails) throw new Error(typeof opts.promptFails === 'string' ? opts.promptFails : '未配置模型');
      return { ok: true };
    }
    return undefined;
  });
}

async function boot(active = 'A', opts: StubOpts = {}) {
  stubRpc(opts);
  const chat = useChat();
  await chat.init();
  await chat.open(active);
  return chat;
}

/** 模拟 minisd 的 chat.event 广播（index.ts 的 run IIFE 发出的形态）。 */
function emit(sessionId: string, event: Record<string, unknown>): void {
  const h = handlers.get('chat.event');
  if (!h) throw new Error('init() 没有订阅 chat.event');
  h({ sessionId, event });
}

const TOOL_START = { kind: 'toolStart', toolUseId: 't1', name: 'file_write', title: 'x', input: '{}' };
const messagesListCalls = (sid: string) =>
  rpcCallMock.mock.calls.filter(c => c[0] === 'chat.messages.list' && c[1]?.sessionId === sid).length;

beforeEach(() => {
  rpcCallMock.mockReset();
  handlers.clear();
  setActivePinia(createPinia());
});

describe('W2b-1 运行集合：非当前会话的事件也要记账', () => {
  it('B 的回合事件进 runningSessions，但不串进当前会话 A 的流式区、也不改 A 的 running', async () => {
    const chat = await boot('A');
    emit('B', TOOL_START);
    expect(chat.runningSessions).toEqual(['B']);
    expect(chat.running).toBe(false);
    expect(chat.toolCards).toHaveLength(0);
    // 幂等：同一会话连续多个事件不重复入集合
    emit('B', { kind: 'textDelta', text: '一半' });
    emit('B', { kind: 'toolEnd', toolUseId: 't1', success: true, output: 'ok' });
    expect(chat.runningSessions).toEqual(['B']);
    expect(chat.streamingText).toBe('');
  });

  it('turnEnd 与 error 都把会话移出集合（非当前会话同样生效）', async () => {
    const chat = await boot('A');
    emit('B', TOOL_START);
    emit('B', { kind: 'turnEnd', stopReason: 'endTurn' });
    expect(chat.runningSessions).toEqual([]);
    emit('B', { kind: 'textDelta', text: 'x' });
    expect(chat.runningSessions).toEqual(['B']);
    emit('B', { kind: 'error', message: '已取消' });
    expect(chat.runningSessions).toEqual([]);
  });

  it('synced 载荷不是回合事件，不参与运行集合', async () => {
    const chat = await boot('A');
    handlers.get('chat.event')!({ kind: 'synced', sessionId: 'B', mergedCount: 1, fromDevice: 'abcdef' });
    expect(chat.runningSessions).toEqual([]);
  });

  it('send() 发出即把当前会话记进集合——回合第一个事件到达之前切走，也不会漏记', async () => {
    const chat = await boot('A');
    await chat.send('你好');
    expect(chat.running).toBe(true);
    expect(chat.runningSessions).toEqual(['A']);
    // 一个事件都还没到就切走再切回：停止键仍然在
    await chat.open('B');
    await chat.open('A');
    expect(chat.running).toBe(true);
  });

  it('send() 被 chat.prompt 拒绝后，集合里不残留当前会话', async () => {
    const chat = await boot('A', { promptFails: true });
    await chat.send('你好');
    expect(chat.lastError).toContain('未配置模型');
    expect(chat.running).toBe(false);
    expect(chat.runningSessions).toEqual([]);
  });
});

describe('W2b-1 切回仍在跑的会话：停止键可用 + midRun 占位', () => {
  it('open() 切到仍在跑的 B：running=true（停止键按 sessionId 取消），midRun=true', async () => {
    const chat = await boot('A');
    emit('B', TOOL_START);
    await chat.open('B');
    expect(chat.activeId).toBe('B');
    expect(chat.running).toBe(true);
    expect(chat.midRun).toBe(true);
    // 停止键走 chat.cancel()，它按 activeId 取 controller——切回之后点停止就是停 B
    await chat.cancel();
    expect(rpcCallMock).toHaveBeenCalledWith('chat.cancel', { sessionId: 'B' });
  });

  it('A 在跑时切到空闲的 B：running=false、midRun=false；再切回 A：running=true、midRun=true', async () => {
    const chat = await boot('A');
    await chat.send('你好');
    emit('A', { kind: 'textDelta', text: '前半句' });
    expect(chat.midRun).toBe(false); // 本窗口发起的回合是从头看着的，不算中途接上
    await chat.open('B');
    expect(chat.running).toBe(false);
    expect(chat.midRun).toBe(false);
    // 切走期间 A 的事件继续到达：只记账，不写进 B 的流式区
    emit('A', { kind: 'textDelta', text: '后半句' });
    expect(chat.streamingText).toBe('');
    expect(chat.runningSessions).toEqual(['A']);
    await chat.open('A');
    expect(chat.running).toBe(true);
    expect(chat.midRun).toBe(true);
  });

  it('从 midRun 会话切到空闲会话：open() 把 midRun 清零——否则空闲会话里下一回合整段被占位挡到 turnEnd', async () => {
    const chat = await boot('A');
    emit('B', TOOL_START);
    await chat.open('B');
    expect(chat.midRun).toBe(true); // 前提：切走之前 midRun 确实是 true，下面的清零才有东西可清
    await chat.open('A'); // A 空闲
    expect(chat.running).toBe(false);
    expect(chat.midRun).toBe(false);
    // 在 A 里正常发一条：这一回合是本窗口从头看着的，流式区照常长，不挡占位
    await chat.send('你好');
    emit('A', { kind: 'textDelta', text: '从头开始' });
    expect(chat.running).toBe(true);
    expect(chat.midRun).toBe(false);
    expect(chat.streamingText).toBe('从头开始');
  });

  it('send() 发出的回合从头看着：midRun 当场清零；被后端拒绝后也不留「midRun 却没在跑」的矛盾态', async () => {
    // 可达路径：A 上一回合出错 → EventNotes 留着重试钮（它不看 running）→ 别处在 A 上起了新回合，
    // 本窗口从中途接上（midRun）→ 用户点重试 → retryLast() → send()，后端以「该会话正在运行中」拒绝
    const chat = await boot('A', { promptFails: '该会话正在运行中', history: true });
    emit('A', { kind: 'error', message: '上游 500' });
    await new Promise(r => setTimeout(r)); // 让 error 触发的 open(A) 自刷新落地，免得它晚到清缓冲干扰下面
    emit('A', { kind: 'textDelta', text: '别处发起的回合' });
    expect(chat.midRun).toBe(true);
    expect(chat.eventNotes.some(n => n.kind === 'error' && n.retryable)).toBe(true); // 重试钮此刻确实在
    const p = chat.retryLast();
    // send() 同步段已跑完、chat.prompt 尚未回话：本窗口发起的回合不算中途接上
    expect(chat.running).toBe(true);
    expect(chat.midRun).toBe(false);
    await p;
    expect(chat.lastError).toContain('该会话正在运行中');
    expect(chat.running).toBe(false);
    expect(chat.midRun).toBe(false);
    // 别处的回合还在跑：它的下一个事件照常把 A 认回「中途接上」，停止键回来
    emit('A', { kind: 'textDelta', text: '继续' });
    expect(chat.runningSessions).toEqual(['A']);
    expect(chat.running).toBe(true);
    expect(chat.midRun).toBe(true);
  });

  it('midRun 回合 turnEnd：清 midRun、running 归零、同步丢掉切回后接上的半截缓冲，再重取完整历史', async () => {
    const chat = await boot('A');
    emit('B', TOOL_START);
    await chat.open('B');
    emit('B', { kind: 'textDelta', text: '句子的后半截' });
    emit('B', { kind: 'toolStart', toolUseId: 't2', name: 'file_read', title: 'y', input: '{}' });
    // 前提：turnEnd 到达时手里确有半截正文与步骤卡，下面的同步清空才有东西可清
    expect(chat.streamingText).toBe('句子的后半截');
    expect(chat.toolCards).toHaveLength(1);
    const before = messagesListCalls('B');
    emit('B', { kind: 'turnEnd', stopReason: 'endTurn' });
    // 同步断言：open() 重取历史是异步的，这一段空档里半截文字不能冒出来
    expect(chat.midRun).toBe(false);
    expect(chat.running).toBe(false);
    expect(chat.streamingText).toBe('');
    expect(chat.toolCards).toHaveLength(0);
    expect(chat.runningSessions).toEqual([]);
    expect(messagesListCalls('B')).toBe(before + 1);
  });

  it('midRun 回合 error：同样清 midRun、running 归零、同步丢掉半截正文与步骤卡，错误照常可见', async () => {
    const chat = await boot('A');
    emit('B', TOOL_START);
    await chat.open('B');
    emit('B', { kind: 'textDelta', text: '半截' });
    emit('B', { kind: 'toolStart', toolUseId: 't2', name: 'file_read', title: 'y', input: '{}' });
    // 前提：error 到达时手里确有半截正文与步骤卡——否则下面的「清空」断言本来就空，钉不住 error 分支的清空
    expect(chat.streamingText).toBe('半截');
    expect(chat.toolCards).toHaveLength(1);
    emit('B', { kind: 'error', message: '已取消' });
    expect(chat.midRun).toBe(false);
    expect(chat.running).toBe(false);
    expect(chat.streamingText).toBe('');
    expect(chat.toolCards).toHaveLength(0);
    expect(chat.lastError).toBe('已取消');
    expect(chat.runningSessions).toEqual([]);
  });

  it('当前会话收到回合中途的事件、本窗口却不知道它在跑（渲染端重载后 / 回合由别处发起）：同样置 running 与 midRun', async () => {
    const chat = await boot('A');
    expect(chat.running).toBe(false);
    emit('A', { kind: 'textDelta', text: '从中间开始' });
    expect(chat.runningSessions).toEqual(['A']);
    expect(chat.running).toBe(true);
    expect(chat.midRun).toBe(true);
  });
});

describe('W2b-1 StageChat：midRun 时实时块只显示占位', () => {
  const src = fs.readFileSync(path.join(root, 'src/renderer/src/ui/StageChat.vue'), 'utf8').replace(/\r\n/g, '\n');
  // 交接 §2 第 10 条：断言不能被注释喂饱——模板先剥 HTML 注释再匹配
  const tpl = src.slice(src.indexOf('<template>'), src.lastIndexOf('</template>')).replace(/<!--[\s\S]*?-->/g, '');
  const live = /<section v-if="hasLive" class="turn" data-turn-id="live">([\s\S]*?)<\/section>/.exec(tpl)?.[1] ?? '';

  it('实时块第一项是 midRun 占位，文案说清「仍在运行、切换前的输出回合结束后显示」', () => {
    expect(live, '找不到实时回合块').not.toBe('');
    expect(live).toMatch(/^\s*<div v-if="chat\.midRun"[^>]*>\s*仍在运行（切换前的输出在本回合结束后显示）\s*<\/div>\s*<template v-else>/);
  });

  it('半截的思考 / 步骤 / 正文 / 「正在思考」全部收在 v-else 里，midRun 时一样都不渲染', () => {
    const m = /<template v-else>([\s\S]*?)<\/template>/.exec(live);
    expect(m, 'midRun 占位之后缺 <template v-else>').not.toBeNull();
    const inner = m![1];
    const outer = live.replace(m![0], '');
    for (const re of [/<ThinkBlock live :text="chat\.streamingThinking"/, /<StepGroup\s+live/, /:nodes="streamNodes"/, /正在思考…/]) {
      expect(inner).toMatch(re);
      expect(outer).not.toMatch(re);
    }
  });
});
