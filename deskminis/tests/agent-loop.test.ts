import { describe, it, expect } from 'vitest';
import { runAgentLoop, pairToolResults, placeholderOldMediaRefs, type LoopEvent } from '../src/minisd/agent/loop';
import type { AgentMessage } from '../src/shared/types';
import { buildAnthropicBody } from '../src/minisd/providers/anthropic';
import { openDb } from '../src/minisd/store/db';
import { ChatStore } from '../src/minisd/store/chat-store';
import { ToolRegistry } from '../src/minisd/tools/registry';
import { ProviderError, type AgentProvider, type StreamRequest } from '../src/minisd/providers/types';
import type { AgentStreamEvent } from '../src/shared/types';
import type { ToolContext, ToolExecutor } from '../src/minisd/tools/types';
import { MinisPaths } from '../src/minisd/paths';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextPolicy } from '../src/minisd/agent/context-policy';
import { OffloadEngine } from '../src/minisd/agent/offload';
import { CompactEngine } from '../src/minisd/agent/compact';

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
    // 浅拷贝快照：loop 在 slot 间复用同一个 req 对象并就地改写 systemPrompt/maxTokens，
    // 存引用的话，后续 slot 的改写会污染先前 slot 的快照（标量字段断言会看到最后一次的值）
    this.seen.push({ ...req });
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
  const toolContext: ToolContext = { sessionId: s.id, paths, permissions: { async check() { return 'allow'; }, hasBridgeGrant: () => false } };
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

  it('thinking-only 响应视作空响应 → 走降级路径且不落库', async () => {
    const { store, tools, toolContext, sessionId } = mkCtx();
    store.appendMessage({ id: 'U1', sessionId, role: 'user', parts: [{ type: 'text', value: 'x' }], createdAt: store.nowEpoch(), streamInterruptCount: 0 });
    // 只有思考、无正文无工具调用：A1 后 thinking part 会前置进 assistantParts，若按 parts 长度判定
    // 会绕过空响应两路、落库一条用户看不见内容的 thinking-only 消息。现在应走空响应降级。
    const main = new ScriptedProvider([[ { kind: 'thinkingComplete', text: '思考过程', signature: 'sig-1' }, { kind: 'done', stopReason: 'endTurn' } ]]);
    const backup = new ScriptedProvider([[ { kind: 'textDelta', text: 'ok' }, { kind: 'done', stopReason: 'endTurn' } ]]);
    const events = await collect(runAgentLoop(store, {
      sessionId, provider: main, tools, toolContext, systemPrompt: 'sys', retryDelaysMs: [0],
      fallbackChain: [{ provider: backup, label: 'backup-1' }],
    }));
    // 走空响应降级路径：fallback 到 backup，backup 正常回复
    expect(events.some(e => e.kind === 'fallback')).toBe(true);
    expect(events.some(e => e.kind === 'textDelta' && e.text === 'ok')).toBe(true);
    // 不落库 thinking-only assistant 消息：只剩原始 user + backup 的 assistant(text)
    const msgs = store.listMessages(sessionId);
    expect(msgs).toHaveLength(2);
    expect(msgs[1].parts).toEqual([{ type: 'text', value: 'ok' }]);
  });

  it('thinking-only 响应且无降级链 → 报「模型返回了空响应」且不落库', async () => {
    const { store, tools, toolContext, sessionId } = mkCtx();
    store.appendMessage({ id: 'U1', sessionId, role: 'user', parts: [{ type: 'text', value: 'x' }], createdAt: store.nowEpoch(), streamInterruptCount: 0 });
    const provider = new ScriptedProvider([[ { kind: 'thinkingComplete', text: '思考过程', signature: 'sig-1' }, { kind: 'done', stopReason: 'endTurn' } ]]);
    const events = await collect(runAgentLoop(store, { sessionId, provider, tools, toolContext, systemPrompt: 'sys', retryDelaysMs: [0] }));
    const last = events.at(-1);
    expect(last).toMatchObject({ kind: 'error' });
    if (last?.kind === 'error') expect(last.message).toContain('空响应');
    // 不落库 thinking-only assistant 消息
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

  it('thinkingComplete + toolCallComplete → 落库消息 parts 里 thinking 在最前', async () => {
    const { store, tools, toolContext, sessionId } = mkCtx();
    store.appendMessage({ id: 'U1', sessionId, role: 'user', parts: [{ type: 'text', value: 'do it' }], createdAt: store.nowEpoch(), streamInterruptCount: 0 });
    const provider = new ScriptedProvider([
      [
        { kind: 'thinkingComplete', text: '思考过程', signature: 'sig-1' },
        { kind: 'toolCallComplete', toolUseId: 'T1', name: 'echo', input: '{"text":"hi","tool_title":"回声"}' },
        { kind: 'done', stopReason: 'toolUse' },
      ],
      [ { kind: 'textDelta', text: '完成' }, { kind: 'done', stopReason: 'endTurn' } ],
    ]);
    await collect(runAgentLoop(store, { sessionId, provider, tools, toolContext, systemPrompt: 'sys' }));
    const msgs = store.listMessages(sessionId);
    const assistant = msgs[1];
    // Anthropic 块序要求：thinking 必须先于 text 与 toolUse
    expect(assistant.parts[0]).toEqual({ type: 'thinking', value: { text: '思考过程', signature: 'sig-1' } });
    expect(assistant.parts[1]).toEqual({ type: 'toolUse', value: { toolUseId: 'T1', name: 'echo', input: '{"text":"hi","tool_title":"回声"}' } });
  });

  // ── maxTokens 截断自动续写 ──

  /** 断言请求 messages 末尾是否带合成续写提示（仅请求侧、不落库）。 */
  const hasContinuationHint = (req: StreamRequest): boolean => {
    const last = req.messages.at(-1)!;
    const t = last.parts.find(p => p.type === 'text');
    return t !== undefined && (t.value as string).includes('因长度上限被截断');
  };

  it('maxTokens 截断自动续写：不 turnEnd，下一轮注入合成提示且不落库', async () => {
    const { store, tools, toolContext, sessionId } = mkCtx();
    store.appendMessage({ id: 'U1', sessionId, role: 'user', parts: [{ type: 'text', value: '写长文' }], createdAt: store.nowEpoch(), streamInterruptCount: 0 });
    const provider = new ScriptedProvider([
      // 第一轮：输出到一半撞上 maxTokens（无工具调用）
      [ { kind: 'textDelta', text: '前半段' }, { kind: 'done', stopReason: 'maxTokens' } ],
      // 第二轮：续写完成
      [ { kind: 'textDelta', text: '后半段' }, { kind: 'done', stopReason: 'endTurn' } ],
    ]);
    const events = await collect(runAgentLoop(store, { sessionId, provider, tools, toolContext, systemPrompt: 'sys' }));
    // 第一轮 maxTokens 不 turnEnd，续写一轮后以 endTurn 收尾
    expect(events.at(-1)).toEqual({ kind: 'turnEnd', stopReason: 'endTurn' });
    // 第二轮请求的 messages 末尾是合成续写提示（role=user、text 含「因长度上限被截断」）
    expect(hasContinuationHint(provider.seen[1])).toBe(true);
    // 落库两条 assistant 消息；合成提示绝不落库
    const msgs = store.listMessages(sessionId);
    expect(msgs.filter(m => m.role === 'assistant')).toHaveLength(2);
    expect(msgs.some(m => m.parts.some(p => p.type === 'text' && (p.value as string).includes('因长度上限被截断')))).toBe(false);
  });

  it('连续三轮 maxTokens：续写只发生 2 次后正常 turnEnd', async () => {
    const { store, tools, toolContext, sessionId } = mkCtx();
    store.appendMessage({ id: 'U1', sessionId, role: 'user', parts: [{ type: 'text', value: '写超长' }], createdAt: store.nowEpoch(), streamInterruptCount: 0 });
    const provider = new ScriptedProvider([
      [ { kind: 'textDelta', text: '第一段' }, { kind: 'done', stopReason: 'maxTokens' } ],
      [ { kind: 'textDelta', text: '第二段' }, { kind: 'done', stopReason: 'maxTokens' } ],
      [ { kind: 'textDelta', text: '第三段' }, { kind: 'done', stopReason: 'maxTokens' } ],
    ]);
    const events = await collect(runAgentLoop(store, { sessionId, provider, tools, toolContext, systemPrompt: 'sys' }));
    // 恰好 3 次请求；第 1 次无提示，第 2、3 次带提示（续写恰好发生 2 次）
    expect(provider.calls).toBe(3);
    expect(hasContinuationHint(provider.seen[0])).toBe(false);
    expect(hasContinuationHint(provider.seen[1])).toBe(true);
    expect(hasContinuationHint(provider.seen[2])).toBe(true);
    // 达到续写上限后正常 turnEnd（stopReason 仍为 maxTokens）
    expect(events.at(-1)).toEqual({ kind: 'turnEnd', stopReason: 'maxTokens' });
  });

  // ── maxTokens 按 slot 重算（A4b）──

  it('maxTokens 传定值：请求原样携带（向后兼容）', async () => {
    const { store, tools, toolContext, sessionId } = mkCtx();
    store.appendMessage({ id: 'U1', sessionId, role: 'user', parts: [{ type: 'text', value: 'x' }], createdAt: store.nowEpoch(), streamInterruptCount: 0 });
    const provider = new ScriptedProvider([[ { kind: 'textDelta', text: 'ok' }, { kind: 'done', stopReason: 'endTurn' } ]]);
    await collect(runAgentLoop(store, { sessionId, provider, tools, toolContext, systemPrompt: 'sys', maxTokens: 1234 }));
    expect(provider.seen[0].maxTokens).toBe(1234);
  });

  it('maxTokens 传工厂：降级切换 slot 后按新 modelId 重算', async () => {
    const { store, tools, toolContext, sessionId } = mkCtx();
    store.appendMessage({ id: 'U1', sessionId, role: 'user', parts: [{ type: 'text', value: 'x' }], createdAt: store.nowEpoch(), streamInterruptCount: 0 });
    const main = new ScriptedProvider([ new ProviderError('限流', { status: 429 }) ]);
    const backup = new ScriptedProvider([[ { kind: 'textDelta', text: 'ok' }, { kind: 'done', stopReason: 'endTurn' } ]]);
    // ScriptedProvider 的 modelId 固定 'fake'：测试里用 defineProperty 区分主/备模型名
    Object.defineProperty(main, 'modelId', { value: 'big-model' });
    Object.defineProperty(backup, 'modelId', { value: 'small-model' });
    await collect(runAgentLoop(store, {
      sessionId, provider: main, tools, toolContext, systemPrompt: 'sys', retryDelaysMs: [0],
      // 主模型大输出上限、备胎小上限——降级后请求必须换用备胎的值，否则会被小端点 400 拒收
      maxTokens: ({ modelId }) => (modelId === 'big-model' ? 64000 : 8192),
      fallbackChain: [{ provider: backup, label: 'backup-1' }],
    }));
    expect(main.seen[0].maxTokens).toBe(64000);
    expect(backup.seen[0].maxTokens).toBe(8192);
  });

  // ── M2b 降级链 ──

  it('fallbackable 错误触发降级到 fallbackChain 下一 slot', async () => {
    const { store, tools, toolContext, sessionId } = mkCtx();
    store.appendMessage({ id: 'U1', sessionId, role: 'user', parts: [{ type: 'text', value: 'x' }], createdAt: store.nowEpoch(), streamInterruptCount: 0 });
    const main = new ScriptedProvider([ new ProviderError('限流', { status: 429 }) ]);
    const backup = new ScriptedProvider([[ { kind: 'textDelta', text: '备选回复' }, { kind: 'done', stopReason: 'endTurn' } ]]);
    const events = await collect(runAgentLoop(store, {
      sessionId, provider: main, tools, toolContext, systemPrompt: 'sys', retryDelaysMs: [0],
      fallbackChain: [{ provider: backup, label: 'backup-1' }],
    }));
    expect(events.some(e => e.kind === 'fallback' && (e as any).to === 'backup-1')).toBe(true);
    expect(events.some(e => e.kind === 'textDelta' && e.text === '备选回复')).toBe(true);
    expect(events.at(-1)).toEqual({ kind: 'turnEnd', stopReason: 'endTurn' });
  });

  it('降级成功后后续 turn 继续用 backup provider（不从主 provider 重新开始）', async () => {
    const { store, tools, toolContext, sessionId } = mkCtx();
    store.appendMessage({ id: 'U1', sessionId, role: 'user', parts: [{ type: 'text', value: 'do' }], createdAt: store.nowEpoch(), streamInterruptCount: 0 });
    const main = new ScriptedProvider([ new ProviderError('限流', { status: 429 }) ]);
    const backup = new ScriptedProvider([
      [ { kind: 'toolCallComplete', toolUseId: 'T1', name: 'echo', input: '{"text":"hi","tool_title":"回声"}' }, { kind: 'done', stopReason: 'toolUse' } ],
      [ { kind: 'textDelta', text: 'done' }, { kind: 'done', stopReason: 'endTurn' } ],
    ]);
    const events = await collect(runAgentLoop(store, {
      sessionId, provider: main, tools, toolContext, systemPrompt: 'sys', retryDelaysMs: [0],
      fallbackChain: [{ provider: backup, label: 'backup-1' }],
    }));
    // backup 被调用了 2 次（工具调用 + 文本回复），main 只被调了 1 次（首次 429）
    expect(main.calls).toBe(1);
    expect(backup.calls).toBe(2);
    expect(events.at(-1)).toEqual({ kind: 'turnEnd', stopReason: 'endTurn' });
  });

  it('降级链全部 fallbackable → error 事件终止', async () => {
    const { store, tools, toolContext, sessionId } = mkCtx();
    store.appendMessage({ id: 'U1', sessionId, role: 'user', parts: [{ type: 'text', value: 'x' }], createdAt: store.nowEpoch(), streamInterruptCount: 0 });
    const main = new ScriptedProvider([ new ProviderError('限流', { status: 429 }) ]);
    const backup = new ScriptedProvider([ new ProviderError('也限流', { status: 429 }) ]);
    const events = await collect(runAgentLoop(store, {
      sessionId, provider: main, tools, toolContext, systemPrompt: 'sys', retryDelaysMs: [0],
      fallbackChain: [{ provider: backup, label: 'backup-1' }],
    }));
    expect(events.at(-1)).toMatchObject({ kind: 'error', message: '所有模型均不可用' });
  });

  it('空响应（无 tool_result 的首轮）→ 直接降级，不注入 system-reminder', async () => {
    const { store, tools, toolContext, sessionId } = mkCtx();
    store.appendMessage({ id: 'U1', sessionId, role: 'user', parts: [{ type: 'text', value: 'x' }], createdAt: store.nowEpoch(), streamInterruptCount: 0 });
    const main = new ScriptedProvider([[ { kind: 'done', stopReason: 'endTurn' } ]]); // 空响应
    const backup = new ScriptedProvider([[ { kind: 'textDelta', text: 'ok' }, { kind: 'done', stopReason: 'endTurn' } ]]);
    const events = await collect(runAgentLoop(store, {
      sessionId, provider: main, tools, toolContext, systemPrompt: 'sys', retryDelaysMs: [0],
      fallbackChain: [{ provider: backup, label: 'backup-1' }],
    }));
    expect(events.some(e => e.kind === 'fallback')).toBe(true);
    expect(events.some(e => e.kind === 'textDelta' && e.text === 'ok')).toBe(true);
    // 不应注入 system-reminder（历史里不应出现 [系统提醒] 文本）
    const msgs = store.listMessages(sessionId);
    expect(msgs.some(m => m.parts.some(p => p.type === 'text' && (p.value as string).includes('系统提醒')))).toBe(false);
  });

  it('tool_result 后空响应 → 先注入 system-reminder 重试，仍空则降级', async () => {
    const { store, tools, toolContext, sessionId } = mkCtx();
    store.appendMessage({ id: 'U1', sessionId, role: 'user', parts: [{ type: 'text', value: 'do' }], createdAt: store.nowEpoch(), streamInterruptCount: 0 });
    const main = new ScriptedProvider([
      [ { kind: 'toolCallComplete', toolUseId: 'T1', name: 'echo', input: '{"text":"hi","tool_title":"回声"}' }, { kind: 'done', stopReason: 'toolUse' } ],
      [ { kind: 'done', stopReason: 'endTurn' } ], // tool_result 后空响应
      [ { kind: 'done', stopReason: 'endTurn' } ], // reminder 重试仍空
    ]);
    const backup = new ScriptedProvider([[ { kind: 'textDelta', text: 'backup' }, { kind: 'done', stopReason: 'endTurn' } ]]);
    const events = await collect(runAgentLoop(store, {
      sessionId, provider: main, tools, toolContext, systemPrompt: 'sys', retryDelaysMs: [0],
      fallbackChain: [{ provider: backup, label: 'backup-1' }],
    }));
    // 提醒不再落库：store 里不出现 [系统提醒: 文本（持久化历史不被机器留言污染）
    const msgs = store.listMessages(sessionId);
    expect(msgs.some(m => m.parts.some(p => p.type === 'text' && (p.value as string).includes('[系统提醒:')))).toBe(false);
    // 但出现在 reminder 重试那一轮的请求 messages 末尾（仅请求侧合成 user 消息）
    const retryReq = main.seen[2];
    expect(retryReq.messages.at(-1)).toMatchObject({ role: 'user', parts: [{ type: 'text', value: '[系统提醒: 上一次工具调用后你返回了空响应，请继续]' }] });
    // 最终降级到 backup
    expect(events.some(e => e.kind === 'fallback')).toBe(true);
    expect(events.some(e => e.kind === 'textDelta' && e.text === 'backup')).toBe(true);
  });

  it('用户正文含「系统提醒」四字不再误判 → 照常注入仅请求侧提醒并恢复', async () => {
    const { store, tools, toolContext, sessionId } = mkCtx();
    store.appendMessage({ id: 'U1', sessionId, role: 'user', parts: [{ type: 'text', value: 'do' }], createdAt: store.nowEpoch(), streamInterruptCount: 0 });
    // 第 1 次调用进行中往 store 追加一条正文恰含「系统提醒」的 user 消息（模拟远端/另一入口
    // 在回合进行中插话）——必须赶在第 2 轮顶部 listMessages 快照之前落库，它才会成为
    // 「最后一条 user 消息」；createdAt+1 保证排在工具结果载体之后。旧实现按「最后一条
    // user 消息含系统提醒」判重，会把这条用户正文误认成已注入的提醒，跳过恢复机会
    // 直接报「模型返回了空响应」。
    const main = new ScriptedProvider([
      [ { kind: 'toolCallComplete', toolUseId: 'T1', name: 'echo', input: '{"text":"hi","tool_title":"回声"}' }, { kind: 'done', stopReason: 'toolUse' } ],
      [ { kind: 'done', stopReason: 'endTurn' } ], // tool_result 后空响应
      [ { kind: 'textDelta', text: '好的' }, { kind: 'done', stopReason: 'endTurn' } ], // 提醒后恢复
    ], (n) => {
      if (n === 0) {
        store.appendMessage({ id: 'U-remote', sessionId, role: 'user', parts: [{ type: 'text', value: '顺便讲讲系统提醒是什么意思' }], createdAt: store.nowEpoch() + 1, streamInterruptCount: 0 });
      }
    });
    const events = await collect(runAgentLoop(store, { sessionId, provider: main, tools, toolContext, systemPrompt: 'sys', retryDelaysMs: [0] }));
    // 恢复而非报错（旧实现此处 ends with error「模型返回了空响应」）
    expect(events.at(-1)).toMatchObject({ kind: 'turnEnd', stopReason: 'endTurn' });
    expect(events.some(e => e.kind === 'textDelta' && e.text === '好的')).toBe(true);
    // store 里含「[系统提醒:」的消息一条都没有：插话是用户自己的，提醒是请求侧合成的
    expect(store.listMessages(sessionId).some(m => m.parts.some(p => p.type === 'text' && (p.value as string).includes('[系统提醒:')))).toBe(false);
    // 第 3 次请求（提醒重试轮）末尾带上了合成提醒
    expect(main.seen[2].messages.at(-1)).toMatchObject({ role: 'user', parts: [{ type: 'text', value: '[系统提醒: 上一次工具调用后你返回了空响应，请继续]' }] });
  });

  it('retryable 错误走重试梯不走降级（M1 行为不变）', async () => {
    const { store, tools, toolContext, sessionId } = mkCtx();
    store.appendMessage({ id: 'U1', sessionId, role: 'user', parts: [{ type: 'text', value: 'x' }], createdAt: store.nowEpoch(), streamInterruptCount: 0 });
    const main = new ScriptedProvider([
      new ProviderError('529', { status: 529 }),
      [ { kind: 'textDelta', text: 'ok' }, { kind: 'done', stopReason: 'endTurn' } ],
    ]);
    const events = await collect(runAgentLoop(store, {
      sessionId, provider: main, tools, toolContext, systemPrompt: 'sys', retryDelaysMs: [0],
      fallbackChain: [{ provider: new ScriptedProvider([[ { kind: 'textDelta', text: '不该走到' }, { kind: 'done', stopReason: 'endTurn' } ]]), label: 'backup-1' }],
    }));
    expect(events.some(e => e.kind === 'retry')).toBe(true);
    expect(events.some(e => e.kind === 'fallback')).toBe(false);
    expect(events.some(e => e.kind === 'textDelta' && e.text === 'ok')).toBe(true);
  });
});

// ── 附件请求侧合成：store 落 mediaRef，请求侧替换为 imageData（base64），raw history 永不改写 ──
describe('runAgentLoop + 附件请求侧合成', () => {
  /** 1×1 真实 PNG（最小合法头）：内容无所谓，重点是字节 → base64 的往返可断言。 */
  const TINY_PNG = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f030005fe02fea72d99480000000049454e44ae426082',
    'hex',
  );

  function seedAttachment(toolContext: ToolContext, sessionId: string, name: string): string {
    // 必须落进 toolContext.paths 的附件桶——loop 请求侧合成读的是这份；写到别的临时根会读不到
    writeFileSync(join(toolContext.paths.sessionBucket(sessionId, 'attachments'), name), TINY_PNG);
    return `attachments/${name}`;
  }

  it('user 消息带 mediaRef → provider 收到 imageData(base64)，store 仍是 mediaRef', async () => {
    const { store, tools, toolContext, sessionId } = mkCtx();
    const rel = seedAttachment(toolContext, sessionId, 'tiny.png');
    store.appendMessage({
      id: 'U1', sessionId, role: 'user', createdAt: store.nowEpoch(), streamInterruptCount: 0,
      parts: [
        { type: 'text', value: '看图' },
        { type: 'mediaRef', value: { id: 'M1', relativePath: rel, mimeType: 'image/png' } },
      ],
    });
    const provider = new ScriptedProvider([[ { kind: 'textDelta', text: '看到了' }, { kind: 'done', stopReason: 'endTurn' } ]]);
    await collect(runAgentLoop(store, { sessionId, provider, tools, toolContext, systemPrompt: 'sys' }));
    // 请求侧：mediaRef 已替换为 imageData，base64 与磁盘字节一致
    const parts = provider.seen[0].messages[0].parts;
    expect(parts[0]).toEqual({ type: 'text', value: '看图' });
    expect(parts[1]).toEqual({ type: 'imageData', value: { mimeType: 'image/png', base64: TINY_PNG.toString('base64') } });
    // 存储侧：raw history 未被改写，仍是 mediaRef
    const stored = store.listMessages(sessionId);
    expect(stored[0].parts[1]).toEqual({ type: 'mediaRef', value: { id: 'M1', relativePath: rel, mimeType: 'image/png' } });
  });

  it('附件文件缺失 → 请求侧替换为 [附件已丢失] 文本 part（模型知情，不静默消失）', async () => {
    const { store, tools, toolContext, sessionId } = mkCtx();
    // 落了又删：mediaRef 指向一个已不存在的文件
    const rel = seedAttachment(toolContext, sessionId, 'ghost.png');
    rmSync(join(toolContext.paths.sessionBucket(sessionId, 'attachments'), 'ghost.png'));
    store.appendMessage({
      id: 'U1', sessionId, role: 'user', createdAt: store.nowEpoch(), streamInterruptCount: 0,
      parts: [{ type: 'mediaRef', value: { id: 'M1', relativePath: rel, mimeType: 'image/png' } }],
    });
    const provider = new ScriptedProvider([[ { kind: 'textDelta', text: '没看到图' }, { kind: 'done', stopReason: 'endTurn' } ]]);
    await collect(runAgentLoop(store, { sessionId, provider, tools, toolContext, systemPrompt: 'sys' }));
    const part = provider.seen[0].messages[0].parts[0];
    expect(part.type).toBe('text');
    expect((part as { value: string }).value).toContain('[附件已丢失');
    expect((part as { value: string }).value).toContain('ghost.png');
  });

  it('两轮工具循环：附件只读一次（缓存生效——第二轮前删文件仍能拿到 imageData）', async () => {
    const { store, tools, toolContext, sessionId } = mkCtx();
    const rel = seedAttachment(toolContext, sessionId, 'once.png');
    const abs = join(toolContext.paths.sessionBucket(sessionId, 'attachments'), 'once.png');
    store.appendMessage({
      id: 'U1', sessionId, role: 'user', createdAt: store.nowEpoch(), streamInterruptCount: 0,
      parts: [{ type: 'mediaRef', value: { id: 'M1', relativePath: rel, mimeType: 'image/png' } }],
    });
    const provider = new ScriptedProvider([
      [ { kind: 'toolCallComplete', toolUseId: 'T1', name: 'echo', input: '{"text":"hi","tool_title":"回声"}' }, { kind: 'done', stopReason: 'toolUse' } ],
      [ { kind: 'textDelta', text: '完成' }, { kind: 'done', stopReason: 'endTurn' } ],
    ], (n) => {
      // 第一轮读完附件后立刻删文件：第二轮若重读必失败，只有缓存命中才能继续带上 imageData
      if (n === 0) rmSync(abs);
    });
    await collect(runAgentLoop(store, { sessionId, provider, tools, toolContext, systemPrompt: 'sys' }));
    expect(provider.calls).toBe(2);
    const second = provider.seen[1].messages.flatMap((m: any) => m.parts).find((p: any) => p.type === 'imageData');
    expect(second).toEqual({ type: 'imageData', value: { mimeType: 'image/png', base64: TINY_PNG.toString('base64') } });
  });
});

// ── F2b 历史图片占位：最近 2 轮的 mediaRef 照常 resolve，更早轮次换占位文本 ──
// 多轮带图会话历史图片 base64 全量复带进每次请求，随轮次累计撞载荷上限；
// 占位发生在请求组装层（resolve 之前，不读文件省 IO），raw history 原样存储。
describe('runAgentLoop + 历史图片占位（F2b）', () => {
  const TINY_PNG = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f030005fe02fea72d99480000000049454e44ae426082',
    'hex',
  );

  /** 4 轮带图历史：U1(旧) A1 U2 A2 U3 A3 U4(当前轮)——U1/U2 应成占位，U3/U4 应保留 base64。 */
  function seedFourRounds(store: ChatStore, sessionId: string, rels: string[]): void {
    let n = 0;
    for (const rel of rels) {
      store.appendMessage({
        id: `U${++n}`, sessionId, role: 'user', createdAt: store.nowEpoch() + n, streamInterruptCount: 0,
        parts: [
          { type: 'text', value: `第${n}轮看图` },
          { type: 'mediaRef', value: { id: `M${n}`, relativePath: rel, mimeType: 'image/png' } },
        ],
      });
      store.appendMessage({
        id: `A${n}`, sessionId, role: 'assistant', createdAt: store.nowEpoch() + n + 0.5, streamInterruptCount: 0,
        parts: [{ type: 'text', value: `第${n}轮回复` }],
      });
    }
  }

  it('4 轮带图历史 → 最早 2 轮图片成占位文本，最近 2 轮（含当前轮）保留 imageData(base64)', async () => {
    const { store, tools, toolContext, sessionId } = mkCtx();
    // U3/U4 的附件真实落盘（最近 2 轮要 resolve）；U1/U2 不落盘——若占位没在 resolve 前跑，
    // 它们会变成 [附件已丢失] 而非占位文本，此断言即失败
    for (const name of ['keep3.png', 'keep4.png']) {
      writeFileSync(join(toolContext.paths.sessionBucket(sessionId, 'attachments'), name), TINY_PNG);
    }
    seedFourRounds(store, sessionId, [
      'attachments/stale1.png', 'attachments/stale2.png',
      'attachments/keep3.png', 'attachments/keep4.png',
    ]);
    const provider = new ScriptedProvider([[ { kind: 'textDelta', text: '收到' }, { kind: 'done', stopReason: 'endTurn' } ]]);
    await collect(runAgentLoop(store, { sessionId, provider, tools, toolContext, systemPrompt: 'sys' }));

    const userMsgs = provider.seen[0].messages.filter(m => m.role === 'user');
    expect(userMsgs).toHaveLength(4);
    // 旧 2 轮：mediaRef → 占位文本（文件名出现在占位里）
    for (const [i, stale] of [0, 1].entries()) {
      const mediaPart = userMsgs[i].parts.find(p => p.type === 'imageData' || p.type === 'mediaRef');
      expect(mediaPart).toBeUndefined();
      const ph = userMsgs[i].parts.find(p => p.type === 'text' && String((p as { value: string }).value).includes('stale'));
      expect(ph).toBeDefined();
      expect(String((ph as { value: string }).value)).toBe(`[图片 stale${stale + 1}.png 已随上下文省略]`);
    }
    // 新 2 轮：imageData base64 与磁盘字节一致
    for (const i of [2, 3]) {
      const img = userMsgs[i].parts.find(p => p.type === 'imageData');
      expect(img).toEqual({ type: 'imageData', value: { mimeType: 'image/png', base64: TINY_PNG.toString('base64') } });
    }
    // 存储侧：raw history 永不改写，4 条 user 消息仍是 mediaRef
    const stored = store.listMessages(sessionId).filter(m => m.role === 'user');
    expect(stored).toHaveLength(4);
    for (const m of stored) expect(m.parts.some(p => p.type === 'mediaRef')).toBe(true);
  });

  it('红线：替换后无空 parts 数组、无空 text part（Anthropic 400 雷）', async () => {
    const { store, tools, toolContext, sessionId } = mkCtx();
    writeFileSync(join(toolContext.paths.sessionBucket(sessionId, 'attachments'), 'keep.png'), TINY_PNG);
    // 纯图消息（无文本）：最旧一轮只有 mediaRef，替换后必须仍有非空内容。
    // 3 轮历史（U1 旧 + U2/U3 最近两轮）：U1 成占位，U2/U3 保留图。
    store.appendMessage({
      id: 'U1', sessionId, role: 'user', createdAt: store.nowEpoch(), streamInterruptCount: 0,
      parts: [{ type: 'mediaRef', value: { id: 'M1', relativePath: 'attachments/stale.png', mimeType: 'image/png' } }],
    });
    store.appendMessage({
      id: 'A1', sessionId, role: 'assistant', createdAt: store.nowEpoch() + 0.5, streamInterruptCount: 0,
      parts: [{ type: 'text', value: '旧回复' }],
    });
    store.appendMessage({
      id: 'U2', sessionId, role: 'user', createdAt: store.nowEpoch() + 1, streamInterruptCount: 0,
      parts: [{ type: 'mediaRef', value: { id: 'M2', relativePath: 'attachments/keep.png', mimeType: 'image/png' } }],
    });
    store.appendMessage({
      id: 'A2', sessionId, role: 'assistant', createdAt: store.nowEpoch() + 1.5, streamInterruptCount: 0,
      parts: [{ type: 'text', value: '新回复' }],
    });
    store.appendMessage({
      id: 'U3', sessionId, role: 'user', createdAt: store.nowEpoch() + 2, streamInterruptCount: 0,
      parts: [{ type: 'mediaRef', value: { id: 'M3', relativePath: 'attachments/keep.png', mimeType: 'image/png' } }],
    });
    const provider = new ScriptedProvider([[ { kind: 'textDelta', text: '好' }, { kind: 'done', stopReason: 'endTurn' } ]]);
    await collect(runAgentLoop(store, { sessionId, provider, tools, toolContext, systemPrompt: 'sys' }));
    for (const m of provider.seen[0].messages) {
      expect(m.parts.length).toBeGreaterThan(0);
      for (const p of m.parts) {
        if (p.type === 'text') expect(String((p as { value: string }).value).trim()).not.toBe('');
      }
    }
    // 纯图旧消息替换后仍是单条非空占位文本
    const first = provider.seen[0].messages[0];
    expect(first.parts).toHaveLength(1);
    expect(first.parts[0]).toEqual({ type: 'text', value: '[图片 stale.png 已随上下文省略]' });
  });
});

/** F2b 纯函数 placeholderOldMediaRefs：轮次边界与保留窗口。 */
describe('placeholderOldMediaRefs', () => {
  const img = (name: string) => ({ type: 'mediaRef' as const, value: { id: 'M', relativePath: `attachments/${name}`, mimeType: 'image/png' } });
  const txt = (v: string) => ({ type: 'text' as const, value: v });

  it('历史只有 2 轮（即最近 2 轮本身）：全部保留，不产生占位', () => {
    const msgs: AgentMessage[] = [
      { role: 'user', parts: [txt('问1'), img('a.png')] },
      { role: 'assistant', parts: [txt('答1')] },
      { role: 'user', parts: [txt('问2'), img('b.png')] },
    ];
    expect(placeholderOldMediaRefs(msgs)).toEqual(msgs);
  });

  it('工具结果载体 user 消息不是轮界：数轮时跳过（对齐 compact.ts isRealUserTurn 惯例）', () => {
    const msgs: AgentMessage[] = [
      { role: 'user', parts: [txt('问1'), img('a.png')] },
      { role: 'assistant', parts: [txt('答1')] },
      { role: 'user', parts: [{ type: 'toolResult', value: { toolUseId: 'T1', output: 'o', success: true, status: 'success' } }] },
      { role: 'user', parts: [txt('问2'), img('b.png')] },
      { role: 'assistant', parts: [txt('答2')] },
      { role: 'user', parts: [txt('问3'), img('c.png')] },
    ];
    const out = placeholderOldMediaRefs(msgs);
    // 轮界 = 问1/问2/问3（toolResult 载体不算）：最近 2 轮 = 问2/问3 → 只有问1 的 a.png 成占位
    expect(out[0].parts).toEqual([txt('问1'), txt('[图片 a.png 已随上下文省略]')]);
    expect(out[3].parts.some(p => p.type === 'mediaRef')).toBe(true);
    expect(out[5].parts.some(p => p.type === 'mediaRef')).toBe(true);
    // 输入不可变：原数组未被改写
    expect(msgs[0].parts[1].type).toBe('mediaRef');
  });
});

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

describe('runAgentLoop + 压缩/卸载装配', () => {
  it('大工具结果触发卸载：toolEnd 广播完整 output，落库为桩', async () => {
    const { store, tools, toolContext, sessionId } = mkCtx();
    // 注册一个返回大输出的工具
    const bigTool: ToolExecutor = {
      definition: { name: 'big', description: '大输出', parameters: { tool_title: { type: 'string', description: 't' } }, required: ['tool_title'] },
      async execute() { return { output: 'B'.repeat(25_000), success: true }; },
    };
    tools.register(bigTool);
    store.appendMessage({ id: 'U1', sessionId, role: 'user', parts: [{ type: 'text', value: '调用 big' }], createdAt: store.nowEpoch(), streamInterruptCount: 0 });
    const provider = new ScriptedProvider([[
      { kind: 'toolCallComplete', toolUseId: 'T1', name: 'big', input: '{"tool_title":"大输出"}' },
      { kind: 'done', stopReason: 'toolUse' },
    ], [
      { kind: 'textDelta', text: '完成' }, { kind: 'done', stopReason: 'endTurn' },
    ]]);
    const offload = new OffloadEngine(new MinisPaths(mkdtempSync(join(tmpdir(), 'dm-off-'))));
    const events = await collect(runAgentLoop(store, { sessionId, provider, tools, toolContext, systemPrompt: 'sys', offloadEngine: offload }));
    // toolEnd 事件广播完整 output
    const toolEnd = events.find(e => e.kind === 'toolEnd') as any;
    expect(toolEnd.output.length).toBe(25_000);
    // 落库的 tool_result output 是桩
    const msgs = store.listMessages(sessionId);
    const toolResultMsg = msgs.find(m => m.parts.some(p => p.type === 'toolResult'));
    const trPart = toolResultMsg!.parts.find(p => p.type === 'toolResult')!.value as any;
    expect(trPart.output).toContain('[CONTEXT OFFLOADED');
    expect(trPart.output.length).toBeLessThan(500);
    // offloaded 事件
    expect(events.some(e => e.kind === 'offloaded')).toBe(true);
  });

  it('压缩触发：水位超阈值 → compacted 事件 + effectiveHistory 含摘要', async () => {
    const { store, tools, toolContext, sessionId } = mkCtx();
    // 计划内修正：原计划用 window=8000 + 2000字符/条，但 Task 4 的 ContextPolicy.decide
    //   对 <32K 窗口只 offload 不 compact（context-policy.test.ts 已锚定）。
    //   改为 window=64000 + 15000字符/条：12 条 ~180300 chars → ~45075 token → ratio 0.704 → compact；
    //   压缩后 effectiveHistory = [summary, U3,A3,U4,A4,U5,A5] ~90200 chars → ~22550 token → ratio 0.352 → none。
    for (let i = 0; i < 6; i++) {
      store.appendMessage({ id: `U${i}`, sessionId, role: 'user', parts: [{ type: 'text', value: 'x'.repeat(15_000) }], createdAt: i + 1, streamInterruptCount: 0 });
      store.appendMessage({ id: `A${i}`, sessionId, role: 'assistant', parts: [{ type: 'text', value: 'y'.repeat(15_000) }], createdAt: i + 1.5, streamInterruptCount: 0 });
    }
    const policy = new ContextPolicy({ getModelContextWindow: () => 64_000 });
    const compact = new CompactEngine(store);
    // dualProvider：第 1 次被压缩引擎当摘要 provider 调，第 2 次才是正式回复
    let callCount = 0;
    const dualProvider: AgentProvider = {
      name: 'dual', modelId: 'fake',
      async *streamAgentMessage(req) {
        callCount++;
        if (callCount === 1) {
          yield { kind: 'textDelta', text: '压缩摘要' }; yield { kind: 'done', stopReason: 'endTurn' };
          return;
        }
        // 正式回复：effectiveHistory 含 [对话摘要]
        const firstUser = req.messages.find(m => m.role === 'user');
        expect(JSON.stringify(firstUser?.parts)).toContain('[对话摘要]');
        yield { kind: 'textDelta', text: '回复' }; yield { kind: 'done', stopReason: 'endTurn' };
      },
    };
    const events = await collect(runAgentLoop(store, { sessionId, provider: dualProvider, tools, toolContext, systemPrompt: 'sys', contextPolicy: policy, compactEngine: compact }));
    expect(events.some(e => e.kind === 'compacted')).toBe(true);
    expect(callCount).toBe(2); // 1 次摘要 + 1 次正式回复
    expect(events.at(-1)?.kind).toBe('turnEnd');
  });

  // 大字符串压缩属 CPU 密集，云容器算力漂移时会贴线超默认 30s；断言不变，只放宽时限
  it('压缩一次后水位下降：同一循环不再重复压缩', async () => {
    const { store, tools, toolContext, sessionId } = mkCtx();
    // 4 个用户回合：U0/A0 巨大（撑高水位），U1~A3 极小
    // recent 3 真用户回合 = U1,U2,U3；anchor = A0；toSummarize = [U0,A0]
    // 压缩后 effectiveHistory = [summary, U1,A1,U2,A2,U3,A3] 全小 → 水位降到 none → 不再 compact
    // 计划内修正：原计划用 window=1000 + U0/A0=2000字符，但 <32K 窗口不 compact（见上）。
    //   改为 window=64000 + U0/A0=90000字符：raw ~180170 chars → ~45043 token → ratio 0.704 → compact；
    //   压缩后 effectiveHistory = [summary + 6 小消息] ~170 chars → ~43 token → ratio 0.0007 → none。
    store.appendMessage({ id: 'U0', sessionId, role: 'user', parts: [{ type: 'text', value: 'X'.repeat(90_000) }], createdAt: 1, streamInterruptCount: 0 });
    store.appendMessage({ id: 'A0', sessionId, role: 'assistant', parts: [{ type: 'text', value: 'Y'.repeat(90_000) }], createdAt: 2, streamInterruptCount: 0 });
    store.appendMessage({ id: 'U1', sessionId, role: 'user', parts: [{ type: 'text', value: '小1' }], createdAt: 3, streamInterruptCount: 0 });
    store.appendMessage({ id: 'A1', sessionId, role: 'assistant', parts: [{ type: 'text', value: '小A1' }], createdAt: 4, streamInterruptCount: 0 });
    store.appendMessage({ id: 'U2', sessionId, role: 'user', parts: [{ type: 'text', value: '小2' }], createdAt: 5, streamInterruptCount: 0 });
    store.appendMessage({ id: 'A2', sessionId, role: 'assistant', parts: [{ type: 'text', value: '小A2' }], createdAt: 6, streamInterruptCount: 0 });
    store.appendMessage({ id: 'U3', sessionId, role: 'user', parts: [{ type: 'text', value: '小3' }], createdAt: 7, streamInterruptCount: 0 });
    store.appendMessage({ id: 'A3', sessionId, role: 'assistant', parts: [{ type: 'text', value: '小A3' }], createdAt: 8, streamInterruptCount: 0 });
    const policy = new ContextPolicy({ getModelContextWindow: () => 64_000 });
    const compact = new CompactEngine(store);
    let callCount = 0;
    const provider: AgentProvider = {
      name: 'p', modelId: 'fake',
      async *streamAgentMessage(req) {
        callCount++;
        if (callCount === 1) { yield { kind: 'textDelta', text: '对话摘要' }; yield { kind: 'done', stopReason: 'endTurn' }; return; }
        // 第 2 次：effectiveHistory 已含摘要且水位下降不再 compact
        const firstUser = req.messages.find(m => m.role === 'user');
        expect(JSON.stringify(firstUser?.parts)).toContain('[对话摘要]');
        yield { kind: 'textDelta', text: '回复' }; yield { kind: 'done', stopReason: 'endTurn' };
      },
    };
    const events = await collect(runAgentLoop(store, { sessionId, provider, tools, toolContext, systemPrompt: 'sys', contextPolicy: policy, compactEngine: compact }));
    // 恰好 1 次 compacted（压缩后 effectiveHistory 变小、水位降到 none，同一循环不再重复压缩）
    expect(events.filter(e => e.kind === 'compacted')).toHaveLength(1);
    expect(callCount).toBe(2); // 1 次摘要 + 1 次正式回复
    expect(events.at(-1)?.kind).toBe('turnEnd');
    expect(store.getLatestCompactMarker(sessionId)?.summary).toBe('对话摘要');
  }, 120000);

  // 大字符串修剪属 CPU 密集，云容器算力漂移时会贴线超默认 30s；断言不变，只放宽时限
  it('offload 档触发修剪：请求里旧大 toolResult 变桩、store 原文未动、发 pruned 事件', async () => {
    const { store, tools, toolContext, sessionId } = mkCtx();
    const big = 'B'.repeat(150_000);
    // 15 条历史：U0(真用户回合) A0(toolUse T0) TR0(旧大 toolResult, idx 2) + 12 条最近消息
    // len=15 → 修剪范围 idx 0..2（len-12=3），TR0 在范围内被修剪；最近 12 条原样。
    // 水位：150000 字符 → ~37500 token，ratio 0.586 ∈ [0.5,0.7) → offload 档。
    store.appendMessage({ id: 'U0', sessionId, role: 'user', parts: [{ type: 'text', value: '请重构' }], createdAt: 1, streamInterruptCount: 0 });
    store.appendMessage({ id: 'A0', sessionId, role: 'assistant', parts: [{ type: 'toolUse', value: { toolUseId: 'T0', name: 'echo', input: '{"text":"x","tool_title":"t"}' } }], createdAt: 2, streamInterruptCount: 0 });
    store.appendMessage({ id: 'TR0', sessionId, role: 'user', parts: [{ type: 'toolResult', value: { toolUseId: 'T0', output: big, success: true, status: 'success' } }], createdAt: 3, streamInterruptCount: 0 });
    for (let i = 0; i < 12; i++) {
      store.appendMessage({ id: `R${i}`, sessionId, role: 'user', parts: [{ type: 'text', value: `最近 ${i}` }], createdAt: 4 + i, streamInterruptCount: 0 });
    }
    const policy = new ContextPolicy({ getModelContextWindow: () => 64_000 });
    const compact = new CompactEngine(store);
    const provider = new ScriptedProvider([[ { kind: 'textDelta', text: '开始重构' }, { kind: 'done', stopReason: 'endTurn' } ]]);
    const events = await collect(runAgentLoop(store, { sessionId, provider, tools, toolContext, systemPrompt: 'sys', contextPolicy: policy, compactEngine: compact }));
    // pruned 事件
    expect(events.some(e => e.kind === 'pruned')).toBe(true);
    // 请求消息里旧大 toolResult 已是桩文本（修剪只影响请求侧合成，与 compact 同哲学）
    const req = provider.seen[0];
    const trPart = req.messages.flatMap(m => m.parts).find(p => p.type === 'toolResult') as { value: { output: string } };
    expect(trPart.value.output).toContain('已修剪');
    expect(trPart.value.output).toContain('原 150000 字符');
    // store 原文未动（修剪永不改写存储）
    const stored = store.listMessages(sessionId);
    const storedTr = stored.find(m => m.id === 'TR0')!;
    expect(storedTr.parts[0]).toEqual({ type: 'toolResult', value: { toolUseId: 'T0', output: big, success: true, status: 'success' } });
    expect(events.at(-1)?.kind).toBe('turnEnd');
  }, 120000);

  it('excludedToolNames: 过滤工具定义', async () => {
    const { store, tools, toolContext, sessionId } = mkCtx();
    const hiddenTool: ToolExecutor = {
      definition: { name: 'hidden', description: '应被隐藏', parameters: { tool_title: { type: 'string', description: 't' } }, required: ['tool_title'] },
      async execute() { return { output: '不该被调用', success: true }; },
    };
    tools.register(hiddenTool);
    store.appendMessage({ id: 'U1', sessionId, role: 'user', parts: [{ type: 'text', value: '你好' }], createdAt: 1, streamInterruptCount: 0 });
    const provider = new ScriptedProvider([[
      // provider 能看到的 tools 不应含 hidden
      { kind: 'textDelta', text: 'ok' }, { kind: 'done', stopReason: 'endTurn' },
    ]]);
    provider.seen.length = 0;
    const events = await collect(runAgentLoop(store, { sessionId, provider, tools, toolContext, systemPrompt: 'sys', excludedToolNames: new Set(['hidden']) }));
    // 验证 provider 收到的 tools 不含 hidden
    expect(provider.seen[0].tools.find(t => t.name === 'hidden')).toBeUndefined();
    expect(events.at(-1)?.kind).toBe('turnEnd');
  });
});
