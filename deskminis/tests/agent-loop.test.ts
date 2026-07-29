import { describe, it, expect } from 'vitest';
import { runAgentLoop, pairToolResults, type LoopEvent } from '../src/minisd/agent/loop';
import type { AgentMessage } from '../src/shared/types';
import { buildAnthropicBody } from '../src/minisd/providers/anthropic';
import { openDb } from '../src/minisd/store/db';
import { ChatStore } from '../src/minisd/store/chat-store';
import { ToolRegistry } from '../src/minisd/tools/registry';
import { ProviderError, type AgentProvider, type StreamRequest } from '../src/minisd/providers/types';
import type { AgentStreamEvent } from '../src/shared/types';
import type { ToolContext, ToolExecutor } from '../src/minisd/tools/types';
import { MinisPaths } from '../src/minisd/paths';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 一次「先吐半截再炸」的脚本：用于验证重试不会把两次尝试的文本拼在一起。 */
type Script = AgentStreamEvent[] | ProviderError | { events: AgentStreamEvent[]; error: ProviderError };

/** 脚本化假 Provider：按调用次数吐不同的事件序列，并记录收到的请求。 */
class ScriptedProvider implements AgentProvider {
  readonly name = 'scripted'; readonly modelId = 'fake';
  calls = 0;
  /** 每次调用收到的历史快照（断言 provider 侧看到的消息序列） */
  seen: StreamRequest[] = [];
  constructor(private scripts: Script[], private onCall?: (n: number) => void) {}
  async *streamAgentMessage(req: StreamRequest): AsyncIterable<AgentStreamEvent> {
    const n = this.calls++;
    this.seen.push(req);
    this.onCall?.(n);
    const s = this.scripts[n];
    if (s instanceof ProviderError) throw s;
    if (Array.isArray(s)) { for (const e of s) yield e; return; }
    for (const e of s.events) yield e;
    throw s.error;
  }
}

const echoTool: ToolExecutor = {
  definition: { name: 'echo', description: 'echo', parameters: { text: { type: 'string', description: 't' }, tool_title: { type: 'string', description: 't' } }, required: ['text', 'tool_title'] },
  async execute(input) { return { output: `echo:${String(input.text)}`, success: true }; },
};

function mkCtx(): { store: ChatStore; tools: ToolRegistry; toolContext: ToolContext; sessionId: string } {
  const store = new ChatStore(openDb(':memory:'));
  const s = store.createSession();
  const tools = new ToolRegistry(); tools.register(echoTool);
  const root = mkdtempSync(join(tmpdir(), 'dm-loop-'));
  const paths = new MinisPaths(root); paths.ensureSessionDirs(s.id);
  const toolContext: ToolContext = { sessionId: s.id, paths, permissions: { async check() { return 'allow'; } } };
  return { store, tools, toolContext, sessionId: s.id };
}

async function collect(gen: AsyncGenerator<LoopEvent>): Promise<LoopEvent[]> {
  const out: LoopEvent[] = []; for await (const e of gen) out.push(e); return out;
}

describe('runAgentLoop', () => {
  it('纯文本回复: 落库 + turnEnd', async () => {
    const { store, tools, toolContext, sessionId } = mkCtx();
    store.appendMessage({ id: 'U1', sessionId, role: 'user', parts: [{ type: 'text', value: '你好' }], createdAt: store.nowEpoch(), streamInterruptCount: 0 });
    const provider = new ScriptedProvider([[
      { kind: 'textDelta', text: '你' }, { kind: 'textDelta', text: '好呀' },
      { kind: 'usage', usage: { inputTokens: 3, outputTokens: 2 } }, { kind: 'done', stopReason: 'endTurn' },
    ]]);
    const events = await collect(runAgentLoop(store, { sessionId, provider, tools, toolContext, systemPrompt: 'sys' }));
    expect(events.filter(e => e.kind === 'textDelta')).toHaveLength(2);
    expect(events.at(-1)).toEqual({ kind: 'turnEnd', stopReason: 'endTurn' });
    const msgs = store.listMessages(sessionId);
    expect(msgs).toHaveLength(2);
    expect(msgs[1].parts).toEqual([{ type: 'text', value: '你好呀' }]);
  });

  it('一轮工具调用后再回复', async () => {
    const { store, tools, toolContext, sessionId } = mkCtx();
    store.appendMessage({ id: 'U1', sessionId, role: 'user', parts: [{ type: 'text', value: 'do it' }], createdAt: store.nowEpoch(), streamInterruptCount: 0 });
    const provider = new ScriptedProvider([
      [ { kind: 'toolCallComplete', toolUseId: 'T1', name: 'echo', input: '{"text":"hi","tool_title":"回声"}' }, { kind: 'done', stopReason: 'toolUse' } ],
      [ { kind: 'textDelta', text: '完成' }, { kind: 'done', stopReason: 'endTurn' } ],
    ]);
    const events = await collect(runAgentLoop(store, { sessionId, provider, tools, toolContext, systemPrompt: 'sys' }));
    expect(events.find(e => e.kind === 'toolStart')).toMatchObject({ name: 'echo', title: '回声' });
    expect(events.find(e => e.kind === 'toolEnd')).toMatchObject({ success: true, output: 'echo:hi' });
    const msgs = store.listMessages(sessionId);
    // user + assistant(toolUse) + user(toolResult) + assistant(text)
    expect(msgs).toHaveLength(4);
    expect(msgs[1].parts[0]).toMatchObject({ type: 'toolUse', value: { toolUseId: 'T1' } });
    expect(msgs[2].parts[0]).toMatchObject({ type: 'toolResult', value: { toolUseId: 'T1', success: true } });
    expect(msgs[2].role).toBe('user');
  });

  it('retryable 错误触发透明重试(注入 0 延迟)', async () => {
    const { store, tools, toolContext, sessionId } = mkCtx();
    store.appendMessage({ id: 'U1', sessionId, role: 'user', parts: [{ type: 'text', value: 'x' }], createdAt: store.nowEpoch(), streamInterruptCount: 0 });
    const provider = new ScriptedProvider([
      new ProviderError('529', { status: 529 }),
      [ { kind: 'textDelta', text: 'ok' }, { kind: 'done', stopReason: 'endTurn' } ],
    ]);
    const events = await collect(runAgentLoop(store, { sessionId, provider, tools, toolContext, systemPrompt: 'sys', retryDelaysMs: [0] }));
    expect(events.find(e => e.kind === 'retry')).toMatchObject({ attempt: 1 });
    expect(events.some(e => e.kind === 'textDelta' && e.text === 'ok')).toBe(true);
  });

  it('非 retryable 错误发 error 事件并停止', async () => {
    const { store, tools, toolContext, sessionId } = mkCtx();
    store.appendMessage({ id: 'U1', sessionId, role: 'user', parts: [{ type: 'text', value: 'x' }], createdAt: store.nowEpoch(), streamInterruptCount: 0 });
    const provider = new ScriptedProvider([ new ProviderError('bad key', { status: 401, retryable: false }) ]);
    const events = await collect(runAgentLoop(store, { sessionId, provider, tools, toolContext, systemPrompt: 'sys', retryDelaysMs: [0] }));
    expect(events.at(-1)).toMatchObject({ kind: 'error' });
  });

  it('取消优先于重试梯: 请求中途 abort 不再重试', async () => {
    const { store, tools, toolContext, sessionId } = mkCtx();
    store.appendMessage({ id: 'U1', sessionId, role: 'user', parts: [{ type: 'text', value: 'x' }], createdAt: store.nowEpoch(), streamInterruptCount: 0 });
    const controller = new AbortController();
    // 第 1 次调用：先 abort（模拟请求中途取消），再抛 retryable 529 —— 真实 provider 把
    // AbortError 也包成 retryable ProviderError，所以取消必须在 catch 里优先短路。
    const provider = new ScriptedProvider(
      [
        new ProviderError('529', { status: 529 }),
        [ { kind: 'textDelta', text: '不该被重试到' }, { kind: 'done', stopReason: 'endTurn' } ],
      ],
      () => controller.abort(),
    );
    const events = await collect(runAgentLoop(store, {
      sessionId, provider, tools, toolContext, systemPrompt: 'sys',
      signal: controller.signal, retryDelaysMs: [0],
    }));
    expect(events.at(-1)).toEqual({ kind: 'error', message: '已取消' });
    expect(provider.calls).toBe(1);
    expect(events.some(e => e.kind === 'retry')).toBe(false);
  });

  it('空响应不落库(否则会话永久变砖)', async () => {
    const { store, tools, toolContext, sessionId } = mkCtx();
    store.appendMessage({ id: 'U1', sessionId, role: 'user', parts: [{ type: 'text', value: 'x' }], createdAt: store.nowEpoch(), streamInterruptCount: 0 });
    const provider = new ScriptedProvider([[ { kind: 'done', stopReason: 'endTurn' } ]]);
    const events = await collect(runAgentLoop(store, { sessionId, provider, tools, toolContext, systemPrompt: 'sys', retryDelaysMs: [0] }));
    const last = events.at(-1);
    expect(last?.kind).toBe('error');
    expect(last).toMatchObject({ kind: 'error' });
    if (last?.kind === 'error') expect(last.message).toContain('空响应');
    // 只剩原始 user 消息 —— 没有写入 parts:[] 的 assistant 行
    expect(store.listMessages(sessionId)).toHaveLength(1);
  });

  it('中断后不再变砖: 中间孤儿 tool_use 在发送前配对(不改存储)', async () => {
    const { store, tools, toolContext, sessionId } = mkCtx();
    const t0 = store.nowEpoch();
    // 真实故障序列：user('A')、assistant(toolUse T1) —— 工具执行途中进程被杀 ——
    // 重启后 chat.prompt 又追加了新的 user('B')。孤儿 tool_use 落在历史中间，last.role 是 'user'。
    store.appendMessage({ id: 'U1', sessionId, role: 'user', parts: [{ type: 'text', value: 'A' }], createdAt: t0, streamInterruptCount: 0 });
    store.appendMessage({
      id: 'A1', sessionId, role: 'assistant', createdAt: t0 + 1, streamInterruptCount: 0,
      parts: [{ type: 'toolUse', value: { toolUseId: 'T1', name: 'echo', input: '{"text":"hi","tool_title":"回声"}' } }],
    });
    store.appendMessage({ id: 'U2', sessionId, role: 'user', parts: [{ type: 'text', value: 'B' }], createdAt: t0 + 2, streamInterruptCount: 0 });

    const provider = new ScriptedProvider([[ { kind: 'textDelta', text: '继续' }, { kind: 'done', stopReason: 'endTurn' } ]]);
    const events = await collect(runAgentLoop(store, { sessionId, provider, tools, toolContext, systemPrompt: 'sys' }));
    expect(events.at(-1)).toEqual({ kind: 'turnEnd', stopReason: 'endTurn' });

    // 存储未被改写：只是这一回合新增了 assistant(text)，没有插入占位 toolResult 行
    const msgs = store.listMessages(sessionId);
    expect(msgs).toHaveLength(4);
    expect(msgs.map(m => m.id).slice(0, 3)).toEqual(['U1', 'A1', 'U2']);
    expect(msgs[3].role).toBe('assistant');
    expect(msgs[3].parts[0]).toMatchObject({ type: 'text', value: '继续' });

    // provider 收到的历史里 tool_use 与 tool_result 一一配对（Anthropic 编码后逐块核对）
    const body = buildAnthropicBody(provider.seen[0], 'claude-x') as { messages: { content: Record<string, unknown>[] }[] };
    const useIds: unknown[] = []; const resultIds: unknown[] = [];
    for (const m of body.messages) for (const b of m.content) {
      if (b.type === 'tool_use') useIds.push(b.id);
      if (b.type === 'tool_result') resultIds.push(b.tool_use_id);
    }
    expect(useIds).toEqual(['T1']);
    expect(resultIds).toEqual(['T1']);
  });

  it('重试不重复: 第 1 次尝试流出的半截文本/工具调用不进入落库结果', async () => {
    const { store, tools, toolContext, sessionId } = mkCtx();
    store.appendMessage({ id: 'U1', sessionId, role: 'user', parts: [{ type: 'text', value: 'x' }], createdAt: store.nowEpoch(), streamInterruptCount: 0 });
    const provider = new ScriptedProvider([
      // 第 1 次：吐了 'AB' 和一个工具调用之后才炸（可重试）
      {
        events: [
          { kind: 'textDelta', text: 'AB' },
          { kind: 'toolCallComplete', toolUseId: 'T_STALE', name: 'echo', input: '{"text":"stale","tool_title":"陈旧"}' },
        ],
        error: new ProviderError('529', { status: 529 }),
      },
      [ { kind: 'textDelta', text: 'XY' }, { kind: 'done', stopReason: 'endTurn' } ],
    ]);
    const events = await collect(runAgentLoop(store, { sessionId, provider, tools, toolContext, systemPrompt: 'sys', retryDelaysMs: [0] }));
    expect(events.find(e => e.kind === 'retry')).toMatchObject({ attempt: 1 });
    const msgs = store.listMessages(sessionId);
    expect(msgs).toHaveLength(2);
    // 'ABXY' 才是 bug 的样子；陈旧的工具调用也不能留下
    expect(msgs[1].parts).toEqual([{ type: 'text', value: 'XY' }]);
    expect(events.some(e => e.kind === 'toolStart')).toBe(false);
  });

  it('非法工具入参落成 {}: 不抛异常, 会话仍可编码给 Anthropic', async () => {
    const { store, tools, toolContext, sessionId } = mkCtx();
    store.appendMessage({ id: 'U1', sessionId, role: 'user', parts: [{ type: 'text', value: 'do it' }], createdAt: store.nowEpoch(), streamInterruptCount: 0 });
    const provider = new ScriptedProvider([
      [ { kind: 'toolCallComplete', toolUseId: 'T1', name: 'echo', input: '{"bad' }, { kind: 'done', stopReason: 'toolUse' } ],
      [ { kind: 'textDelta', text: '好的' }, { kind: 'done', stopReason: 'endTurn' } ],
    ]);
    const events = await collect(runAgentLoop(store, { sessionId, provider, tools, toolContext, systemPrompt: 'sys', retryDelaysMs: [0] }));

    const msgs = store.listMessages(sessionId);
    expect(msgs[1].parts[0]).toEqual({ type: 'toolUse', value: { toolUseId: 'T1', name: 'echo', input: '{}' } });
    // 注册表 preflight 把它变成错误结果喂回模型，而不是抛出去
    expect(events.find(e => e.kind === 'toolEnd')).toMatchObject({ success: false });
    expect(events.at(-1)).toMatchObject({ kind: 'turnEnd' });
    // 会话没变砖：下一次请求的历史能被 Anthropic 正常编码
    expect(() => buildAnthropicBody(provider.seen[1], 'claude-x')).not.toThrow();
  });

  it('历史里的陈年非法入参: Anthropic 编码降级成 {} 而不是抛 SyntaxError', () => {
    // 修复前落库的行（或被截断的流）仍躺在库里：编码必须容错，否则该会话永远发不出请求
    const body = buildAnthropicBody({
      messages: [{ role: 'assistant', parts: [{ type: 'toolUse', value: { toolUseId: 'T1', name: 'echo', input: '{"bad' } }] }],
      systemPrompt: 'sys', tools: [], maxTokens: 100, thinkingLevel: 'off',
    }, 'claude-x') as { messages: { content: Record<string, unknown>[] }[] };
    expect(body.messages[0].content[0]).toEqual({ type: 'tool_use', id: 'T1', name: 'echo', input: {} });
  });

  it('toolCallComplete 的 thoughtSignature 持久化到 toolUse part', async () => {
    const { store, tools, toolContext, sessionId } = mkCtx();
    store.appendMessage({ id: 'U1', sessionId, role: 'user', parts: [{ type: 'text', value: 'x' }], createdAt: store.nowEpoch(), streamInterruptCount: 0 });
    const provider = new ScriptedProvider([
      [ { kind: 'toolCallComplete', toolUseId: 'T1', name: 'echo', input: '{"text":"hi","tool_title":"回声"}', thoughtSignature: 'sig-1' }, { kind: 'done', stopReason: 'toolUse' } ],
      [ { kind: 'textDelta', text: '好' }, { kind: 'done', stopReason: 'endTurn' } ],
    ]);
    await collect(runAgentLoop(store, { sessionId, provider, tools, toolContext, systemPrompt: 'sys' }));
    const msgs = store.listMessages(sessionId);
    expect(msgs[1].parts[0]).toEqual({ type: 'toolUse', value: { toolUseId: 'T1', name: 'echo', input: '{"text":"hi","tool_title":"回声"}', thoughtSignature: 'sig-1' } });
  });
});

/** 纯函数 pairToolResults：发送前对整段历史做 tool_use/tool_result 配对（不改存储）。 */
describe('pairToolResults', () => {
  const text = (v: string): AgentMessage => ({ role: 'user', parts: [{ type: 'text', value: v }] });
  const toolUse = (...ids: string[]): AgentMessage => ({
    role: 'assistant',
    parts: ids.map(id => ({ type: 'toolUse', value: { toolUseId: id, name: 'echo', input: '{}' } })),
  });
  const toolResult = (...ids: string[]): AgentMessage => ({
    role: 'user',
    parts: ids.map(id => ({ type: 'toolResult', value: { toolUseId: id, output: 'ok', success: true, status: 'success' } })),
  });
  /** 断言某个 part 是指向 id 的 cancelled 占位 toolResult。 */
  const isCancelled = (p: unknown, id: string): boolean =>
    JSON.stringify(p) === JSON.stringify({ type: 'toolResult', value: { toolUseId: id, output: '[工具执行被中断，结果未知]', success: false, status: 'cancelled' } });

  it('a) 中间孤儿: assistant(toolUse T1) 后紧跟 user text → 紧随 assistant 插入 T1 的占位 toolResult(先于后面的文本)', () => {
    const out = pairToolResults([text('A'), toolUse('T1'), text('B')]);
    // assistant 之后是一条 user 消息，其首个 part 是 T1 的 cancelled toolResult，文本 'B' 排在其后
    expect(out[1]).toEqual(toolUse('T1'));
    expect(out[2].role).toBe('user');
    expect(isCancelled(out[2].parts[0], 'T1')).toBe(true);
    expect(out[2].parts.some(p => p.type === 'text' && (p as { value: string }).value === 'B')).toBe(true);
    // 占位 toolResult 严格排在文本之前
    const rIdx = out[2].parts.findIndex(p => p.type === 'toolResult');
    const tIdx = out[2].parts.findIndex(p => p.type === 'text');
    expect(rIdx).toBeLessThan(tIdx);
  });

  it('b) 部分配对: assistant(T1,T2,T3) + user(toolResult T1) → 补 T2/T3 占位, 三个 id 都在同一条 user 里', () => {
    const out = pairToolResults([text('go'), toolUse('T1', 'T2', 'T3'), toolResult('T1')]);
    expect(out).toHaveLength(3);
    const follow = out[2];
    expect(follow.role).toBe('user');
    const ids = follow.parts
      .filter(p => p.type === 'toolResult')
      .map(p => (p.value as { toolUseId: string }).toolUseId);
    expect(new Set(ids)).toEqual(new Set(['T1', 'T2', 'T3']));
    // T1 保留原结果, T2/T3 是 cancelled 占位
    const t1 = follow.parts.find(p => p.type === 'toolResult' && (p.value as { toolUseId: string }).toolUseId === 'T1');
    expect(t1).toMatchObject({ value: { toolUseId: 'T1', success: true, status: 'success' } });
    expect(follow.parts.some(p => isCancelled(p, 'T2'))).toBe(true);
    expect(follow.parts.some(p => isCancelled(p, 'T3'))).toBe(true);
  });

  it('c) 尾部孤儿: [user, assistant(toolUse T9)] 之后无消息 → 追加一条带 T9 占位 toolResult 的 user', () => {
    const out = pairToolResults([text('A'), toolUse('T9')]);
    expect(out).toHaveLength(3);
    expect(out[2].role).toBe('user');
    expect(out[2].parts).toHaveLength(1);
    expect(isCancelled(out[2].parts[0], 'T9')).toBe(true);
  });

  it('d) 无操作: 已正确配对的历史原样返回', () => {
    const input: AgentMessage[] = [text('A'), toolUse('T1'), toolResult('T1'), text('后续')];
    const out = pairToolResults(input);
    expect(out).toEqual(input);
    // 未改动的消息保持同一引用（未产生多余拷贝）
    expect(out[1]).toBe(input[1]);
    expect(out[2]).toBe(input[2]);
  });

  it('顺手剥离前导孤儿 tool_result(没有前置 tool_use 的 user toolResult)', () => {
    const out = pairToolResults([toolResult('ORPHAN'), text('hi')]);
    // 孤儿 toolResult 被丢弃, 该 user 消息只剩空 parts, 后续文本保留
    expect(out[0].parts).toHaveLength(0);
    expect(out[1]).toEqual(text('hi'));
  });
});
