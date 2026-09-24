/**
 * DeepSeek V4 回放 reasoning_content（止血波 W2a-4 · 侦察号 S17 · engine.md「W2a-deepseek」与 open_questions 第 6 条）。
 *
 * 为什么要回放：DeepSeek V4 在多轮工具调用里要求把每条 assistant 历史的 reasoning_content 原样带回，
 * 缺了就 400（pi 与 OpenMinis 两个参考项目各自踩到并绕过）。本仓早就把推理存进了库
 * （RawMessage.reasoningContent → messages.reasoning_content），但从库到请求这一路把它丢了：
 * toAgentMessages / buildEffectiveHistory 只映射 {role, parts}，buildOpenAIBody 也从不写这个键。
 *
 * 范围（设计稿 §2「引擎」：DeepSeek V4 全量回放已捕获的推理）：
 * - 只有 deepseek-v4 族写出 reasoning_content，每条 assistant 都带，没捕获到的补空串；
 * - 其它模型（含 deepseek-chat / deepseek-reasoner——旧推理模型输入里带这个键会 400）请求体逐字节不变，
 *   那一面由 tests/provider-body-golden.test.ts 的 sha256 表钉住，这里只补 v4 这一面与链路两端。
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenAIProvider, buildOpenAIBody, requiresReasoningContentEcho, type OpenAICompatFlags } from '../src/minisd/providers/openai';
import { buildAnthropicBody } from '../src/minisd/providers/anthropic';
import { buildGeminiBody } from '../src/minisd/providers/gemini';
import type { AgentProvider, FetchLike, StreamRequest } from '../src/minisd/providers/types';
import type { AgentMessage, AgentStreamEvent, RawMessage, ThinkingLevel } from '../src/shared/types';
import { runAgentLoop, toAgentMessages, type LoopEvent } from '../src/minisd/agent/loop';
import { CompactEngine } from '../src/minisd/agent/compact';
import { ContextPolicy } from '../src/minisd/agent/context-policy';
import { pruneOldToolResults } from '../src/minisd/agent/prune';
import { openDb } from '../src/minisd/store/db';
import { ChatStore } from '../src/minisd/store/chat-store';
import { ToolRegistry } from '../src/minisd/tools/registry';
import type { ToolContext, ToolExecutor } from '../src/minisd/tools/types';
import { MinisPaths } from '../src/minisd/paths';

// ─── 夹具 ────────────────────────────────────────────────────────────────

const TOOL_DEF = {
  name: 'echo', description: 'echo',
  parameters: { text: { type: 'string' as const, description: 't' }, tool_title: { type: 'string' as const, description: 't' } },
  required: ['text', 'tool_title'],
};

/** 多轮工具调用：assistant#1 带推理 R1 与 toolUse，assistant#2 没捕获到推理（字段缺省）。 */
function multiTurnReq(thinkingLevel: ThinkingLevel = 'off'): StreamRequest {
  return {
    systemPrompt: 'sys', tools: [TOOL_DEF], maxTokens: 4096, thinkingLevel,
    messages: [
      { role: 'user', parts: [{ type: 'text', value: '回声一下 hi' }] },
      {
        role: 'assistant',
        parts: [
          { type: 'text', value: '我来调用工具。' },
          { type: 'toolUse', value: { toolUseId: 'T1', name: 'echo', input: '{"text":"hi","tool_title":"回声"}' } },
        ],
        reasoningContent: 'R1',
      },
      { role: 'user', parts: [{ type: 'toolResult', value: { toolUseId: 'T1', output: 'echo:hi', success: true, status: 'success' } }] },
      { role: 'assistant', parts: [{ type: 'text', value: '完成了。' }] },
      { role: 'user', parts: [{ type: 'text', value: '再来一次' }] },
    ],
  };
}

type BodyMsg = Record<string, unknown> & { role: string };
const bodyMessages = (b: Record<string, unknown>): BodyMsg[] => b.messages as BodyMsg[];
const assistantsOf = (b: Record<string, unknown>): BodyMsg[] => bodyMessages(b).filter(m => m.role === 'assistant');

/** 把 v4 请求体里的 reasoning_content 删掉、模型名换掉，应当与同一请求给别的模型的请求体逐字节相同——
 *  证明除了这个键，别处（键序、reasoning_effort、stream_options、tools）一概没动。 */
function withoutEcho(body: Record<string, unknown>, model: string): string {
  const copy = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
  copy.model = model;
  for (const m of copy.messages as Record<string, unknown>[]) delete m.reasoning_content;
  return JSON.stringify(copy);
}

// ─── 判定 ────────────────────────────────────────────────────────────────

describe('requiresReasoningContentEcho：只认 deepseek-v4 族', () => {
  it.each(['deepseek-v4', 'deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-ai/DeepSeek-V4-Pro', 'deepseek/deepseek-v4', 'DEEPSEEK-V4'])('命中 %s', id => {
    expect(requiresReasoningContentEcho(id)).toBe(true);
  });
  // deepseek-reasoner 是旧推理模型：输入里带 reasoning_content 会 400；deepseek-v40 是防「前缀恰好是 v4」的误判
  it.each(['deepseek-chat', 'deepseek-reasoner', 'deepseek-v3.2', 'deepseek-v40', 'gpt-5', 'my-deepseek-v4', ''])('不命中 %s', id => {
    expect(requiresReasoningContentEcho(id)).toBe(false);
  });
});

// ─── 请求体 ──────────────────────────────────────────────────────────────

describe('buildOpenAIBody：v4 族每条 assistant 都带 reasoning_content', () => {
  it('① deepseek-v4-pro 多轮工具调用：依次带 R1 与空串（缺失补空串）', () => {
    const b = buildOpenAIBody(multiTurnReq(), 'deepseek-v4-pro');
    expect(assistantsOf(b).map(m => m.reasoning_content)).toEqual(['R1', '']);
    // 带 toolUse 的那条：tool_calls 照旧，推理挂在同一条消息上
    expect(assistantsOf(b)[0]).toMatchObject({ role: 'assistant', content: '我来调用工具。', tool_calls: [{ id: 'T1' }], reasoning_content: 'R1' });
  });

  it.each(['deepseek-v4-flash', 'deepseek-ai/DeepSeek-V4-Pro', 'deepseek/deepseek-v4'])('② %s 同①', model => {
    expect(assistantsOf(buildOpenAIBody(multiTurnReq(), model)).map(m => m.reasoning_content)).toEqual(['R1', '']);
  });

  it.each(['deepseek-chat', 'deepseek-reasoner', 'deepseek-v3.2', 'deepseek-v40', 'gpt-5'])('② %s：请求体里没有 reasoning_content 这个子串', model => {
    const json = JSON.stringify(buildOpenAIBody(multiTurnReq(), model));
    expect(json).not.toContain('reasoning_content');
    expect(json).not.toContain('R1');
  });

  it('system / user / tool 消息一律不带这个键', () => {
    const b = buildOpenAIBody(multiTurnReq(), 'deepseek-v4-pro');
    const others = bodyMessages(b).filter(m => m.role !== 'assistant');
    expect(others.map(m => m.role)).toEqual(['system', 'user', 'tool', 'user']);
    for (const m of others) expect(Object.keys(m)).not.toContain('reasoning_content');
  });

  it('除了 reasoning_content，v4 的请求体与别的模型逐字节相同（thinkingLevel × flags 四种组合）', () => {
    const flagSets: (OpenAICompatFlags | undefined)[] = [undefined, { reasoningEffort: false }];
    for (const level of ['off', 'high'] as const) for (const flags of flagSets) {
      const req = multiTurnReq(level);
      const v4 = buildOpenAIBody(req, 'deepseek-v4-pro', flags);
      expect(withoutEcho(v4, 'gpt-5'), `${level} ${JSON.stringify(flags)}`).toBe(JSON.stringify(buildOpenAIBody(req, 'gpt-5', flags)));
    }
  });

  it('键写在 assistant 消息的最后（role、content、tool_calls 之后），既有键序不动', () => {
    const b = buildOpenAIBody(multiTurnReq(), 'deepseek-v4-pro');
    expect(Object.keys(assistantsOf(b)[0])).toEqual(['role', 'content', 'tool_calls', 'reasoning_content']);
    expect(Object.keys(assistantsOf(b)[1])).toEqual(['role', 'content', 'reasoning_content']);
  });

  it('OpenAIProvider 实际发出的请求：body 带回放，请求头不变', async () => {
    const calls: { body: string; headers: Record<string, string> }[] = [];
    const fetchImpl = capturingFetch([sse([{ delta: { content: 'ok' }, finish: 'stop' }])], calls);
    const p = new OpenAIProvider({ apiKey: 'k', modelId: 'deepseek-v4-pro', baseUrl: 'https://api.deepseek.com/v1', fetchImpl });
    for await (const _ of p.streamAgentMessage(multiTurnReq())) void _;
    expect(calls).toHaveLength(1);
    expect(calls[0].headers).toEqual({ 'content-type': 'application/json', authorization: 'Bearer k' });
    expect(assistantsOf(JSON.parse(calls[0].body)).map(m => m.reasoning_content)).toEqual(['R1', '']);
  });
});

describe('⑥ Anthropic 与 Gemini 构建器忽略 reasoningContent', () => {
  const strip = (req: StreamRequest): StreamRequest => ({
    ...req, messages: req.messages.map(m => ({ role: m.role, parts: m.parts })),
  });
  it.each([
    ['claude-sonnet-4-5', {}],
    ['claude-opus-5-5', { bindingControls: true }],
    ['m', {}],
  ] as const)('buildAnthropicBody %s：带不带这个字段，请求体完全相等', (model, opts) => {
    for (const level of ['off', 'high'] as const) {
      const req = multiTurnReq(level);
      expect(JSON.stringify(buildAnthropicBody(req, model, opts))).toBe(JSON.stringify(buildAnthropicBody(strip(req), model, opts)));
    }
  });
  it('buildGeminiBody：带不带这个字段，请求体完全相等', () => {
    for (const level of ['off', 'high'] as const) {
      const req = multiTurnReq(level);
      expect(JSON.stringify(buildGeminiBody(req, 'gemini-2.5-pro'))).toBe(JSON.stringify(buildGeminiBody(strip(req), 'gemini-2.5-pro')));
    }
  });
});

// ─── 库 → 请求：透传 ─────────────────────────────────────────────────────

function raw(id: string, role: 'user' | 'assistant', parts: RawMessage['parts'], createdAt: number, extra: Partial<RawMessage> = {}): RawMessage {
  return { id, sessionId: 's', role, parts, createdAt, updatedAt: createdAt, sortOrder: 0, streamInterruptCount: 0, ...extra };
}

describe('toAgentMessages：assistant 条件带上 reasoningContent', () => {
  it('assistant 有推理就带上；没有就不产生这个键（不是值为 undefined 的键）', () => {
    const out = toAgentMessages([
      raw('A1', 'assistant', [{ type: 'text', value: 'a' }], 1, { reasoningContent: 'R1' }),
      raw('A2', 'assistant', [{ type: 'text', value: 'b' }], 2),
      raw('A3', 'assistant', [{ type: 'text', value: 'c' }], 3, { reasoningContent: '' }),
    ]);
    expect(out[0]).toEqual({ role: 'assistant', parts: [{ type: 'text', value: 'a' }], reasoningContent: 'R1' });
    expect(Object.keys(out[1])).toEqual(['role', 'parts']);
    // 空串是捕获到的值（虽然 loop 不会这样落库），按「!== undefined」原样带上
    expect(out[2].reasoningContent).toBe('');
  });

  it('user 消息即使带了这个字段也不透传（推理只属于 assistant）', () => {
    const out = toAgentMessages([raw('U1', 'user', [{ type: 'text', value: 'q' }], 1, { reasoningContent: 'X' })]);
    expect(Object.keys(out[0])).toEqual(['role', 'parts']);
  });

  it('出口消毒照旧：toolResult.output 过 sanitizeMultiline', () => {
    const out = toAgentMessages([raw('U1', 'user', [{ type: 'toolResult', value: { toolUseId: 'T1', output: 'a​b', success: true, status: 'success' } }], 1)]);
    expect((out[0].parts[0].value as { output: string }).output).toBe('ab');
  });

  it('agent-message.ts 导出同一个 toAgentMessage（loop 与 compact 共用，避免 compact 反向 import loop）', async () => {
    const { toAgentMessage } = await import('../src/minisd/agent/agent-message');
    const m = raw('A1', 'assistant', [{ type: 'text', value: 'a' }], 1, { reasoningContent: 'R1' });
    expect(toAgentMessage(m)).toEqual(toAgentMessages([m])[0]);
    expect(toAgentMessage(m).reasoningContent).toBe('R1');
  });
});

describe('④ buildEffectiveHistory：锚点之后的 assistant 保留 reasoningContent', () => {
  const history = [
    raw('U0', 'user', [{ type: 'text', value: '旧问题' }], 1),
    raw('A0', 'assistant', [{ type: 'text', value: '旧回答' }], 2, { reasoningContent: 'OLD' }),
    raw('U1', 'user', [{ type: 'text', value: '新问题' }], 3),
    raw('A1', 'assistant', [{ type: 'toolUse', value: { toolUseId: 'T1', name: 'echo', input: '{}' } }], 4, { reasoningContent: 'THINK' }),
    raw('U2', 'user', [{ type: 'toolResult', value: { toolUseId: 'T1', output: 'o', success: true, status: 'success' } }], 5),
    raw('A2', 'assistant', [{ type: 'text', value: '好了' }], 6),
  ];

  it('有 marker：摘要 + 锚点之后原文，A1 带 THINK，A2 不产生这个键', () => {
    const store = new ChatStore(openDb(':memory:'));
    const marker = { id: 'M1', sessionId: 's', summary: '摘要', lastCompactedMessageId: 'A0', createdAt: 2.5 };
    const out = new CompactEngine(store).buildEffectiveHistory(history, marker);
    expect(out.map(m => m.role)).toEqual(['user', 'user', 'assistant', 'user', 'assistant']);
    expect(out[2].reasoningContent).toBe('THINK');
    expect(Object.keys(out[4])).toEqual(['role', 'parts']);
    // 摘要消息是合成的 user，不带推理；被摘进去的 A0 的推理也不再出现
    expect(JSON.stringify(out)).not.toContain('OLD');
  });

  it('无 marker：全部原文，两条带推理的 assistant 都带上', () => {
    const store = new ChatStore(openDb(':memory:'));
    const out = new CompactEngine(store).buildEffectiveHistory(history, undefined);
    expect(out.filter(m => m.role === 'assistant').map(m => m.reasoningContent)).toEqual(['OLD', 'THINK', undefined]);
  });
});

describe('prune 重建消息时只换 parts，其余字段原样保留', () => {
  it('被修剪的消息仍带着原来的其它字段（防将来 assistant 被修剪时丢推理）', () => {
    const big: AgentMessage = {
      role: 'user',
      parts: [{ type: 'toolResult', value: { toolUseId: 'T1', output: 'x'.repeat(3000), success: true, status: 'success' } }],
      reasoningContent: 'KEEP',
    };
    const { pruned, history } = pruneOldToolResults([big, { role: 'user', parts: [{ type: 'text', value: 'tail' }] }], { keepRecentMessages: 1 });
    expect(pruned).toBe(1);
    expect(history[0].reasoningContent).toBe('KEEP');
    expect((history[0].parts[0].value as { output: string }).output).toContain('已修剪');
  });
});

describe('estimateTokens 仍只数 parts（有意保留，W5 改为以 usage 为锚）', () => {
  it('带不带 reasoningContent，估算值相同', () => {
    const p = new ContextPolicy({ getModelContextWindow: () => 128_000 });
    const parts: AgentMessage['parts'] = [{ type: 'text', value: 'b'.repeat(200) }];
    expect(p.estimateTokens([{ role: 'assistant', parts, reasoningContent: 'r'.repeat(4000) }]))
      .toBe(p.estimateTokens([{ role: 'assistant', parts }]));
  });
});

// ─── loop 级 ─────────────────────────────────────────────────────────────

class ScriptedProvider implements AgentProvider {
  readonly name = 'scripted';
  seen: StreamRequest[] = [];
  private n = 0;
  constructor(private scripts: AgentStreamEvent[][], readonly modelId = 'fake') {}
  async *streamAgentMessage(req: StreamRequest): AsyncIterable<AgentStreamEvent> {
    // 深拷贝快照：loop 跨轮复用对象，存引用会被后续改写污染；用 structuredClone 而不是 JSON 往返——
    // 后者会把值为 undefined 的键悄悄删掉，「不产生值为 undefined 的键」就验不出来了
    this.seen.push(structuredClone(req));
    for (const e of this.scripts[this.n++] ?? []) yield e;
  }
}

const echoTool: ToolExecutor = {
  definition: TOOL_DEF,
  async execute(input) { return { output: `echo:${String(input.text)}`, success: true }; },
};

function mkCtx(): { store: ChatStore; tools: ToolRegistry; toolContext: ToolContext; sessionId: string } {
  const store = new ChatStore(openDb(':memory:'));
  const s = store.createSession();
  const tools = new ToolRegistry(); tools.register(echoTool);
  const paths = new MinisPaths(mkdtempSync(join(tmpdir(), 'dm-dsv4-'))); paths.ensureSessionDirs(s.id);
  const toolContext: ToolContext = { sessionId: s.id, paths, permissions: { async check() { return 'allow'; }, hasBridgeGrant: () => false } };
  return { store, tools, toolContext, sessionId: s.id };
}

async function collect(gen: AsyncGenerator<LoopEvent>): Promise<LoopEvent[]> {
  const out: LoopEvent[] = []; for await (const e of gen) out.push(e); return out;
}

/** 库里：assistant（推理 THINK + toolUse T1）→ T1 的 toolResult → 新的 user 消息。 */
function seedStored(store: ChatStore, sessionId: string): void {
  let t = store.nowEpoch();
  const add = (m: Omit<RawMessage, 'sessionId' | 'createdAt' | 'updatedAt' | 'sortOrder' | 'streamInterruptCount'>) =>
    store.appendMessage({ ...m, sessionId, createdAt: (t += 0.01), streamInterruptCount: 0 });
  add({ id: 'U0', role: 'user', parts: [{ type: 'text', value: '回声一下' }] });
  add({ id: 'A0', role: 'assistant', parts: [{ type: 'toolUse', value: { toolUseId: 'T1', name: 'echo', input: '{"text":"hi","tool_title":"回声"}' } }], reasoningContent: 'THINK' });
  add({ id: 'U1', role: 'user', parts: [{ type: 'toolResult', value: { toolUseId: 'T1', output: 'echo:hi', success: true, status: 'success' } }] });
  add({ id: 'U2', role: 'user', parts: [{ type: 'text', value: '接着来' }] });
}

describe('③ loop 级：库里的推理进了 provider 请求', () => {
  it('无压缩引擎（toAgentMessages 路径）：seen[0] 里那条 assistant 带 THINK', async () => {
    const { store, tools, toolContext, sessionId } = mkCtx();
    seedStored(store, sessionId);
    const provider = new ScriptedProvider([[{ kind: 'textDelta', text: '好' }, { kind: 'done', stopReason: 'endTurn' }]]);
    await collect(runAgentLoop(store, { sessionId, provider, tools, toolContext, systemPrompt: 'sys' }));
    const assistants = provider.seen[0].messages.filter(m => m.role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0].reasoningContent).toBe('THINK');
    // user 消息（含工具结果载体）不带这个键
    for (const m of provider.seen[0].messages.filter(x => x.role === 'user')) expect(Object.keys(m)).toEqual(['role', 'parts']);
  });

  it('带压缩引擎（buildEffectiveHistory 路径）：同样带 THINK', async () => {
    const { store, tools, toolContext, sessionId } = mkCtx();
    seedStored(store, sessionId);
    const provider = new ScriptedProvider([[{ kind: 'textDelta', text: '好' }, { kind: 'done', stopReason: 'endTurn' }]]);
    await collect(runAgentLoop(store, {
      sessionId, provider, tools, toolContext, systemPrompt: 'sys',
      compactEngine: new CompactEngine(store), contextPolicy: new ContextPolicy({ getModelContextWindow: () => 200_000 }),
    }));
    expect(provider.seen[0].messages.find(m => m.role === 'assistant')?.reasoningContent).toBe('THINK');
  });

  it('同一次运行里：第一轮流出的推理落库后，第二轮请求就带回去（工具调用的中间轮）', async () => {
    const { store, tools, toolContext, sessionId } = mkCtx();
    store.appendMessage({ id: 'U0', sessionId, role: 'user', parts: [{ type: 'text', value: 'do it' }], createdAt: store.nowEpoch(), streamInterruptCount: 0 });
    const provider = new ScriptedProvider([
      [
        { kind: 'thinkingDelta', text: 'R' }, { kind: 'thinkingDelta', text: '1' },
        { kind: 'toolCallComplete', toolUseId: 'T1', name: 'echo', input: '{"text":"hi","tool_title":"回声"}' },
        { kind: 'done', stopReason: 'toolUse' },
      ],
      [{ kind: 'textDelta', text: '完成' }, { kind: 'done', stopReason: 'endTurn' }],
    ]);
    await collect(runAgentLoop(store, { sessionId, provider, tools, toolContext, systemPrompt: 'sys' }));
    expect(provider.seen).toHaveLength(2);
    expect(provider.seen[1].messages.map(m => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(provider.seen[1].messages[1].reasoningContent).toBe('R1');
  });
});

// ─── 端到端：库 → loop → OpenAIProvider 实际发出的 body ────────────────────

interface SseStep { delta: Record<string, unknown>; finish?: string }
function sse(steps: SseStep[]): string {
  return steps.map(s => `data: ${JSON.stringify({ choices: [{ index: 0, delta: s.delta, ...(s.finish ? { finish_reason: s.finish } : {}) }] })}\n\n`).join('') + 'data: [DONE]\n\n';
}

/** 按调用次序回放 SSE，并记下每次实际发出的 body 与请求头。 */
function capturingFetch(responses: string[], out: { body: string; headers: Record<string, string> }[]): FetchLike {
  return (async (_input: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    if (init?.headers) for (const [k, v] of new Headers(init.headers as HeadersInit)) headers[k] = v;
    const i = out.length;
    out.push({ body: typeof init?.body === 'string' ? init.body : '', headers });
    return new Response(responses[i] ?? sse([{ delta: {}, finish: 'stop' }]), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as FetchLike;
}

const TOOL_ROUND = sse([
  { delta: { reasoning_content: '先回声' } },
  { delta: { reasoning_content: '再说话' } },
  { delta: { tool_calls: [{ index: 0, id: 'C1', function: { name: 'echo', arguments: '{"text":"hi","tool_title":"回声"}' } }] } },
  { delta: {}, finish: 'tool_calls' },
]);
const FINAL_ROUND = sse([{ delta: { content: '完成' }, finish: 'stop' }]);

async function runE2E(modelId: string): Promise<Record<string, unknown>[]> {
  const { store, tools, toolContext, sessionId } = mkCtx();
  let t = store.nowEpoch();
  // 更早一轮的 assistant 没捕获到推理：v4 要补空串
  store.appendMessage({ id: 'U0', sessionId, role: 'user', parts: [{ type: 'text', value: '你好' }], createdAt: (t += 0.01), streamInterruptCount: 0 });
  store.appendMessage({ id: 'A0', sessionId, role: 'assistant', parts: [{ type: 'text', value: '你好呀' }], createdAt: (t += 0.01), streamInterruptCount: 0 });
  store.appendMessage({ id: 'U1', sessionId, role: 'user', parts: [{ type: 'text', value: '回声一下' }], createdAt: (t += 0.01), streamInterruptCount: 0 });
  const calls: { body: string; headers: Record<string, string> }[] = [];
  const provider = new OpenAIProvider({ apiKey: 'k', modelId, baseUrl: 'https://api.deepseek.com/v1', fetchImpl: capturingFetch([TOOL_ROUND, FINAL_ROUND], calls) });
  const events = await collect(runAgentLoop(store, { sessionId, provider, tools, toolContext, systemPrompt: 'sys' }));
  expect(events.at(-1)).toEqual({ kind: 'turnEnd', stopReason: 'endTurn' });
  // 推理确实落了库（这是回放的来源）
  expect(store.listMessages(sessionId).find(m => m.parts.some(p => p.type === 'toolUse'))?.reasoningContent).toBe('先回声再说话');
  return calls.map(c => JSON.parse(c.body) as Record<string, unknown>);
}

describe('端到端：deepseek-v4 多轮工具调用的第二个请求带回第一轮的推理', () => {
  it('deepseek-v4-pro：第一请求旧 assistant 补空串；第二请求依次是空串与「先回声再说话」', async () => {
    const bodies = await runE2E('deepseek-v4-pro');
    expect(bodies).toHaveLength(2);
    expect(assistantsOf(bodies[0]).map(m => m.reasoning_content)).toEqual(['']);
    expect(assistantsOf(bodies[1]).map(m => m.reasoning_content)).toEqual(['', '先回声再说话']);
    expect(assistantsOf(bodies[1])[1]).toMatchObject({ tool_calls: [{ id: 'C1' }] });
  });

  it('deepseek-chat：库里同样存着推理，但请求体里一个 reasoning_content 都没有', async () => {
    const bodies = await runE2E('deepseek-chat');
    expect(bodies).toHaveLength(2);
    for (const b of bodies) {
      expect(JSON.stringify(b)).not.toContain('reasoning_content');
      expect(JSON.stringify(b)).not.toContain('先回声');
    }
  });
});
