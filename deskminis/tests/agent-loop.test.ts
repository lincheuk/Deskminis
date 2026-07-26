import { describe, it, expect } from 'vitest';
import { runAgentLoop, healInterruptedToolUses, type LoopEvent } from '../src/minisd/agent/loop';
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

  it('循环入口自愈: 孤儿 tool_use 补占位 toolResult(否则该会话此后每次请求都被 400)', async () => {
    const { store, tools, toolContext, sessionId } = mkCtx();
    const t0 = store.nowEpoch();
    store.appendMessage({ id: 'U1', sessionId, role: 'user', parts: [{ type: 'text', value: '跑一下' }], createdAt: t0, streamInterruptCount: 0 });
    // 工具执行途中进程被杀：assistant(toolUse T1) 已落库，配对的 toolResult 永远不会来
    store.appendMessage({
      id: 'A1', sessionId, role: 'assistant', createdAt: t0 + 1, streamInterruptCount: 0,
      parts: [{ type: 'toolUse', value: { toolUseId: 'T1', name: 'echo', input: '{"text":"hi","tool_title":"回声"}' } }],
    });

    const provider = new ScriptedProvider([[ { kind: 'textDelta', text: '继续' }, { kind: 'done', stopReason: 'endTurn' } ]]);
    const events = await collect(runAgentLoop(store, { sessionId, provider, tools, toolContext, systemPrompt: 'sys' }));

    const msgs = store.listMessages(sessionId);
    // user + assistant(toolUse) + user(占位 toolResult) + assistant(text)
    expect(msgs).toHaveLength(4);
    expect(msgs[2].role).toBe('user');
    expect(msgs[2].parts).toEqual([
      { type: 'toolResult', value: { toolUseId: 'T1', output: '[工具执行被中断，结果未知]', success: false, status: 'cancelled' } },
    ]);
    // 占位消息排在这一回合新落库的 assistant 之前
    expect(msgs[3].parts[0]).toMatchObject({ type: 'text', value: '继续' });
    const persisted = events.filter(e => e.kind === 'messagePersisted');
    expect(persisted[0]).toEqual({ kind: 'messagePersisted', messageId: msgs[2].id });

    // provider 收到的历史里 tool_use 与 tool_result 一一配对（Anthropic 编码后逐块核对）
    const body = buildAnthropicBody(provider.seen[0], 'claude-x') as { messages: { content: Record<string, unknown>[] }[] };
    const useIds: unknown[] = []; const resultIds: unknown[] = [];
    for (const m of body.messages) for (const b of m.content) {
      if (b.type === 'tool_use') useIds.push(b.id);
      if (b.type === 'tool_result') resultIds.push(b.tool_use_id);
    }
    expect(useIds).toEqual(['T1']);
    expect(resultIds).toEqual(['T1']);

    // 幂等：历史已经修圆之后再跑不会重复插入
    expect(healInterruptedToolUses(store, sessionId)).toBeUndefined();
    expect(store.listMessages(sessionId)).toHaveLength(4);
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
});
