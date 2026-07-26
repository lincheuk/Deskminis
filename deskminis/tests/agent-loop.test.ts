import { describe, it, expect } from 'vitest';
import { runAgentLoop, type LoopEvent } from '../src/minisd/agent/loop';
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

/** 脚本化假 Provider：按调用次数吐不同的事件序列。 */
class ScriptedProvider implements AgentProvider {
  readonly name = 'scripted'; readonly modelId = 'fake';
  calls = 0;
  constructor(private scripts: (AgentStreamEvent[] | ProviderError)[]) {}
  async *streamAgentMessage(_req: StreamRequest): AsyncIterable<AgentStreamEvent> {
    const s = this.scripts[this.calls++];
    if (s instanceof ProviderError) throw s;
    for (const e of s) yield e;
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
});
