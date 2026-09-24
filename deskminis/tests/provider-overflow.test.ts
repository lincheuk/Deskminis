/**
 * W2a-2 · 溢出分类与 contextFull 契约（止血波设计稿 §3 第 1、2 条；侦察 engine.md「W2a-overflow」引擎部分）。
 *
 * 修前的样子：上下文超窗的 400 与限流、无效 key 一样被判成 fallbackable，loop 立刻降级到组里下一个成员——
 * 下一个成员窗口往往一样大甚至更小，于是整条链挨个白打一遍 400，最后报「所有模型均不可用」；
 * 没有降级链时则把英文原文「Anthropic HTTP 400: prompt is too long…」原样甩给用户，也不给出路。
 *
 * 契约（本文件钉死，渲染端 W2a-6 按它分流）：
 *  - ProviderError.code：'contextOverflow' | 'thinkingBinding'；两者缺省 fallbackable=false、retryable=false；
 *  - loop 在捕获处显式拦截这两个 code（只把 fallbackable 设成 false 挡不住：非 fallbackable 且非 retryable
 *    的错误只要链上还有下一槽位也会降级）；
 *  - 溢出只降级到窗口**更大**的槽位，fallback 事件带 cause:'contextOverflow'、reason「上下文已满」；
 *  - 找不到更大窗口：{kind:'error', code:'contextFull', message, relayDraft}，relayDraft 由库里完整的
 *    最新 marker 摘要加最后一条真用户消息拼成，上限 8000 字；不改绑、不报「所有模型均不可用」。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import WebSocket from 'ws';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isContextOverflowMessage, OVERFLOW_PATTERNS, NON_OVERFLOW_PATTERNS } from '../src/minisd/providers/overflow';
import { ProviderError, isFallbackable, isRetryable, type AgentProvider } from '../src/minisd/providers/types';
import { runAgentLoop, buildRelayDraft, RELAY_DRAFT_MAX, type LoopEvent } from '../src/minisd/agent/loop';
import { ContextPolicy } from '../src/minisd/agent/context-policy';
import { openDb } from '../src/minisd/store/db';
import { ChatStore } from '../src/minisd/store/chat-store';
import { ToolRegistry } from '../src/minisd/tools/registry';
import type { ToolContext, ToolExecutor } from '../src/minisd/tools/types';
import { MinisPaths } from '../src/minisd/paths';
import type { AgentStreamEvent, RawMessage } from '../src/shared/types';
import { startMinisd } from '../src/minisd/index';

// ── ① 识别：pi 的正则表原样搬过来，加状态闸 ──

/** 上游文件头注释里逐家给出的报错样例（每条正则至少一条），用来证明 24 条一条没漏、一条没改坏。 */
const UPSTREAM_SAMPLES = [
  'prompt is too long: 213462 tokens > 200000 maximum', // Anthropic
  '413 {"error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}', // Anthropic 字节超限
  'Input is too long for requested model.', // Bedrock
  'Your input exceeds the context window of this model', // OpenAI
  "Requested token count exceeds the model's maximum context length of 131072 tokens", // LiteLLM
  "Input length (265330) exceeds model's maximum context length (262144).", // OpenAI 兼容
  'The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)', // Gemini
  "This model's maximum prompt length is 131072 but the request contains 537812 tokens", // xAI
  'Please reduce the length of the messages or completion', // Groq
  "This endpoint's maximum context length is 200000 tokens. However, you requested about 250000 tokens", // OpenRouter
  'Input length 300000 exceeds the maximum allowed input length of 262144 tokens.', // OpenRouter/Poolside
  "The input (300000 tokens) is longer than the model's context length (131072 tokens).", // Together
  'prompt token count of 130000 exceeds the limit of 128000', // GitHub Copilot
  'the request exceeds the available context size, try increasing it', // llama.cpp
  'tokens to keep from the initial prompt is greater than the context length', // LM Studio
  'invalid params, context window exceeds limit', // MiniMax
  'Your request exceeded model token limit: 262144 (requested: 300000)', // Kimi
  'Prompt contains 140000 tokens, too large for model with 131072 maximum context length', // Mistral
  'Prompt has 140,000 tokens, but the configured context size is 131,072 tokens', // DS4
  'finish_reason: model_context_window_exceeded', // z.ai
  'prompt too long; exceeded max context length by 1200 tokens', // Ollama
  'Range of input length should be [1, 98304]', // DashScope/Qwen
  'context_length_exceeded', // 通用
  'too many tokens in request', // 通用
  'token limit exceeded', // 通用
];

describe('W2a-2 ① isContextOverflowMessage：识别各家的超窗报错', () => {
  it('pi 的两张表整张搬来：24 条溢出正则、3 条排除正则，上游样例条条命中、每条正则都有样例', () => {
    expect(OVERFLOW_PATTERNS).toHaveLength(24);
    expect(NON_OVERFLOW_PATTERNS).toHaveLength(3);
    for (const s of UPSTREAM_SAMPLES) expect(isContextOverflowMessage(s, 400), s).toBe(true);
    OVERFLOW_PATTERNS.forEach((re, i) => {
      expect(UPSTREAM_SAMPLES.some(s => re.test(s)), `第 ${i + 1} 条 ${re} 没有样例命中`).toBe(true);
    });
  });

  it('侦察列出的真实报文配 400 判为溢出（含国内厂商）', () => {
    const cases = [
      'Anthropic HTTP 400: {"error":{"message":"prompt is too long: 213462 tokens > 200000 maximum"}}',
      'OpenAI HTTP 400: context_length_exceeded',
      "OpenAI HTTP 400: {\"error\":{\"message\":\"This model's maximum context length is 131072 tokens. However, you requested 140000 tokens\"}}", // DeepSeek
      'OpenAI HTTP 400: {"error":{"message":"Your request exceeded model token limit: 262144 (requested: 300000)"}}', // Kimi
      'OpenAI HTTP 400: {"error":{"code":"invalid_parameter_error","message":"Range of input length should be [1, 98304]"}}', // Qwen
      'OpenAI HTTP 400: {"error":{"code":"1261","message":"Prompt too long"}}', // GLM
      'Anthropic HTTP 413: {"error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}',
    ];
    for (const c of cases) expect(isContextOverflowMessage(c, c.includes('413') ? 413 : 400), c).toBe(true);
  });

  it('限流、服务端错误与普通请求错误不算溢出：排除表先于溢出表，429 与 5xx 一律不算', () => {
    // 文本同时命中 /too many tokens/ 与排除表的 /rate limit/：排除表优先
    expect(isContextOverflowMessage('OpenAI HTTP 400: rate limit reached: too many tokens per minute', 400)).toBe(false);
    expect(isContextOverflowMessage('OpenAI HTTP 400: Too many requests, too many tokens', 400)).toBe(false);
    // 状态闸：限流与服务端故障换个窗口更大的模型没用，要走原来的限流降级 / 重试梯
    expect(isContextOverflowMessage('Anthropic HTTP 429: prompt is too long', 429)).toBe(false);
    expect(isContextOverflowMessage('Anthropic HTTP 500: prompt is too long', 500)).toBe(false);
    expect(isContextOverflowMessage('Anthropic HTTP 529: prompt is too long', 529)).toBe(false);
    // 普通 400
    expect(isContextOverflowMessage('x', 400)).toBe(false);
    expect(isContextOverflowMessage('OpenAI HTTP 400: {"error":{"message":"Invalid model name"}}', 400)).toBe(false);
    // 没有状态码（例如流中途的错误文本）照样按文本判
    expect(isContextOverflowMessage('prompt is too long: 213462 tokens > 200000 maximum')).toBe(true);
  });
});

// ── ② ProviderError.code ──

describe('W2a-2 ② ProviderError.code：超窗不再判成可降级', () => {
  it('超窗的 400 推导出 code=contextOverflow，缺省既不降级也不重试', () => {
    const e = new ProviderError('Anthropic HTTP 400: prompt is too long: 213462 tokens > 200000 maximum', { status: 400 });
    expect(e.code).toBe('contextOverflow');
    expect(isFallbackable(e)).toBe(false);
    expect(isRetryable(e)).toBe(false);
  });

  it('413 request_too_large 同样是 contextOverflow', () => {
    const e = new ProviderError('Anthropic HTTP 413: {"error":{"type":"request_too_large"}}', { status: 413 });
    expect(e.code).toBe('contextOverflow');
    expect(isFallbackable(e)).toBe(false);
  });

  it('限流文本、429、普通 400 不带 code，老规则不变', () => {
    const rl = new ProviderError('OpenAI HTTP 400: rate limit exceeded: too many tokens', { status: 400 });
    expect(rl.code).toBeUndefined();
    expect(isFallbackable(rl)).toBe(true);
    const r429 = new ProviderError('Anthropic HTTP 429: prompt is too long', { status: 429 });
    expect(r429.code).toBeUndefined();
    expect(isFallbackable(r429)).toBe(true);
    const plain = new ProviderError('x', { status: 400 });
    expect(plain.code).toBeUndefined();
    expect(isFallbackable(plain)).toBe(true);
  });

  it('opts.code 可以显式给出；联合里另一种 thinkingBinding 缺省同样不降级不重试（即使状态码是 5xx）', () => {
    const b = new ProviderError('Claude 拒绝回放历史思考块', { status: 400, code: 'thinkingBinding' });
    expect(b.code).toBe('thinkingBinding');
    expect(isFallbackable(b)).toBe(false);
    expect(isRetryable(b)).toBe(false);
    const o = new ProviderError('上游说窗口满了', { status: 500, code: 'contextOverflow' });
    expect(o.code).toBe('contextOverflow');
    expect(isRetryable(o)).toBe(false);
    expect(isFallbackable(o)).toBe(false);
    // 显式旗标仍然优先于缺省推导（与既有「显式旗标覆盖默认推导」同一规则）
    expect(isFallbackable(new ProviderError('y', { status: 400, code: 'contextOverflow', fallbackable: true }))).toBe(true);
  });
});

// ── ③–⑩ loop：只降级到更大窗口，否则 contextFull ──

const echoTool: ToolExecutor = {
  definition: { name: 'echo', description: 'echo', parameters: { text: { type: 'string', description: 't' }, tool_title: { type: 'string', description: 't' } }, required: ['text', 'tool_title'] },
  async execute(input) { return { output: `echo:${String(input.text)}`, success: true }; },
};

function mkCtx(): { store: ChatStore; tools: ToolRegistry; toolContext: ToolContext; sessionId: string } {
  const store = new ChatStore(openDb(':memory:'));
  const s = store.createSession();
  const tools = new ToolRegistry(); tools.register(echoTool);
  const root = mkdtempSync(join(tmpdir(), 'dm-overflow-'));
  const paths = new MinisPaths(root); paths.ensureSessionDirs(s.id);
  const toolContext: ToolContext = { sessionId: s.id, paths, permissions: { async check() { return 'allow'; }, hasBridgeGrant: () => false } };
  return { store, tools, toolContext, sessionId: s.id };
}

/** modelId 可指定的脚本化 provider：窗口按 modelId 查表，所以槽位要能各带各的 modelId。 */
class ModelProvider implements AgentProvider {
  readonly name = 'scripted';
  calls = 0;
  constructor(readonly modelId: string, private scripts: (AgentStreamEvent[] | Error)[] = []) {}
  async *streamAgentMessage(): AsyncIterable<AgentStreamEvent> {
    const s = this.scripts[this.calls++];
    if (s instanceof Error) throw s;
    if (!s) throw new Error(`${this.modelId} 收到了未预期的第 ${this.calls} 次请求`);
    for (const e of s) yield e;
  }
}

const WINDOWS: Record<string, number> = { small: 128_000, peer: 128_000, tiny: 32_000, mid: 256_000, big: 1_000_000 };
const policy = new ContextPolicy({ getModelContextWindow: (id: string) => WINDOWS[id] });

const overflow400 = (): ProviderError =>
  new ProviderError('Anthropic HTTP 400: {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 213462 tokens > 200000 maximum"}}', { status: 400 });
const reply = (text: string): AgentStreamEvent[] => [{ kind: 'textDelta', text }, { kind: 'done', stopReason: 'endTurn' }];

/** 手工落库的消息时间逐条递增：listMessages 按 created_at、再按 id 排序，同一毫秒内连落几条会按 id 字母序乱掉。 */
let tick = 0;
const at = (store: ChatStore): number => store.nowEpoch() + (++tick) * 0.001;

function addUser(store: ChatStore, sessionId: string, id: string, text: string): RawMessage {
  return store.appendMessage({ id, sessionId, role: 'user', parts: [{ type: 'text', value: text }], createdAt: at(store), streamInterruptCount: 0 });
}

async function collect(gen: AsyncGenerator<LoopEvent>): Promise<LoopEvent[]> {
  const out: LoopEvent[] = []; for await (const e of gen) out.push(e); return out;
}

describe('W2a-2 ③–⑩ loop：溢出只降级到更大窗口，否则报上下文已满并给接力草稿', () => {
  it('③ 链上只有同样大的窗口：不降级、不请求 peer，以 contextFull 收场', async () => {
    const { store, tools, toolContext, sessionId } = mkCtx();
    addUser(store, sessionId, 'U1', '帮我看看');
    const small = new ModelProvider('small', [overflow400()]);
    const peer = new ModelProvider('peer', [reply('不该走到')]);
    const events = await collect(runAgentLoop(store, {
      sessionId, provider: small, tools, toolContext, systemPrompt: 'sys', retryDelaysMs: [0],
      contextPolicy: policy, fallbackChain: [{ provider: peer, label: 'peer' }], primaryLabel: 'small',
    }));
    expect(events.some(e => e.kind === 'fallback')).toBe(false);
    expect(peer.calls).toBe(0);
    const last = events.at(-1)!;
    expect(last).toMatchObject({ kind: 'error', code: 'contextFull' });
    expect((last as { message: string }).message).toContain('上下文已满');
    expect(typeof (last as { relayDraft?: unknown }).relayDraft).toBe('string');
  });

  it('④ 链为 [peer 128K, big 1M]：跳过 peer 直接降级到 big，事件带 cause 与「上下文已满」，big 跑通后 turnEnd', async () => {
    const { store, tools, toolContext, sessionId } = mkCtx();
    addUser(store, sessionId, 'U1', '帮我看看');
    const small = new ModelProvider('small', [overflow400()]);
    const peer = new ModelProvider('peer', [reply('不该走到')]);
    const big = new ModelProvider('big', [reply('大窗口接手')]);
    const events = await collect(runAgentLoop(store, {
      sessionId, provider: small, tools, toolContext, systemPrompt: 'sys', retryDelaysMs: [0],
      contextPolicy: policy, primaryLabel: 'small',
      fallbackChain: [{ provider: peer, label: 'peer' }, { provider: big, label: 'big' }],
    }));
    const fbs = events.filter(e => e.kind === 'fallback');
    expect(fbs).toEqual([{ kind: 'fallback', from: 'small', to: 'big', reason: '上下文已满', cause: 'contextOverflow' }]);
    expect(peer.calls).toBe(0);
    expect(big.calls).toBe(1);
    expect(events.some(e => e.kind === 'textDelta' && e.text === '大窗口接手')).toBe(true);
    expect(events.at(-1)).toEqual({ kind: 'turnEnd', stopReason: 'endTurn' });
  });

  it('④b 更小的窗口同样跳过；大一档的也超窗时继续找更大的，找到就接手', async () => {
    const { store, tools, toolContext, sessionId } = mkCtx();
    addUser(store, sessionId, 'U1', '帮我看看');
    const small = new ModelProvider('small', [overflow400()]);
    const tiny = new ModelProvider('tiny', [reply('不该走到')]);
    const mid = new ModelProvider('mid', [overflow400()]);
    const big = new ModelProvider('big', [reply('最大的接手')]);
    const events = await collect(runAgentLoop(store, {
      sessionId, provider: small, tools, toolContext, systemPrompt: 'sys', retryDelaysMs: [0],
      contextPolicy: policy, primaryLabel: 'small',
      fallbackChain: [{ provider: tiny, label: 'tiny' }, { provider: mid, label: 'mid' }, { provider: big, label: 'big' }],
    }));
    expect(events.filter(e => e.kind === 'fallback')).toEqual([
      { kind: 'fallback', from: 'small', to: 'mid', reason: '上下文已满', cause: 'contextOverflow' },
      { kind: 'fallback', from: 'mid', to: 'big', reason: '上下文已满', cause: 'contextOverflow' },
    ]);
    expect(tiny.calls).toBe(0);
    expect(events.at(-1)).toEqual({ kind: 'turnEnd', stopReason: 'endTurn' });
  });

  it('⑤ 没有降级链：contextFull，文案是中文，不透出英文 HTTP 400 原文', async () => {
    const { store, tools, toolContext, sessionId } = mkCtx();
    addUser(store, sessionId, 'U1', '帮我看看');
    const small = new ModelProvider('small', [overflow400()]);
    const events = await collect(runAgentLoop(store, {
      sessionId, provider: small, tools, toolContext, systemPrompt: 'sys', retryDelaysMs: [0], contextPolicy: policy,
    }));
    const last = events.at(-1) as { kind: string; code?: string; message: string };
    expect(last.kind).toBe('error');
    expect(last.code).toBe('contextFull');
    expect(last.message).toContain('上下文已满');
    expect(last.message).not.toContain('HTTP 400');
    expect(last.message).not.toContain('prompt is too long');
  });

  it('⑤b 没有 contextPolicy 时各槽位窗口视为相同：链上有 big 也只报上下文已满', async () => {
    const { store, tools, toolContext, sessionId } = mkCtx();
    addUser(store, sessionId, 'U1', '帮我看看');
    const small = new ModelProvider('small', [overflow400()]);
    const big = new ModelProvider('big', [reply('不该走到')]);
    const events = await collect(runAgentLoop(store, {
      sessionId, provider: small, tools, toolContext, systemPrompt: 'sys', retryDelaysMs: [0],
      fallbackChain: [{ provider: big, label: 'big' }],
    }));
    expect(big.calls).toBe(0);
    expect(events.at(-1)).toMatchObject({ kind: 'error', code: 'contextFull' });
  });

  it('⑤c 降级到大窗口后仍超窗、再没有更大的：报上下文已满，不报「所有模型均不可用」', async () => {
    const { store, tools, toolContext, sessionId } = mkCtx();
    addUser(store, sessionId, 'U1', '帮我看看');
    const small = new ModelProvider('small', [overflow400()]);
    const big = new ModelProvider('big', [overflow400()]);
    const events = await collect(runAgentLoop(store, {
      sessionId, provider: small, tools, toolContext, systemPrompt: 'sys', retryDelaysMs: [0],
      contextPolicy: policy, primaryLabel: 'small', fallbackChain: [{ provider: big, label: 'big' }],
    }));
    expect(events.filter(e => e.kind === 'fallback')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ kind: 'error', code: 'contextFull' });
    expect(events.some(e => e.kind === 'error' && e.message === '所有模型均不可用')).toBe(false);
  });

  it('⑥ relayDraft = 库里完整的最新摘要 + 最后一条真用户消息（跳过工具结果那条 user）', async () => {
    const { store, tools, toolContext, sessionId } = mkCtx();
    addUser(store, sessionId, 'U0', '最早的请求');
    store.appendMessage({ id: 'A0', sessionId, role: 'assistant', parts: [{ type: 'text', value: '早先的回答' }], createdAt: at(store), streamInterruptCount: 0 });
    // 完整摘要 3000 字：渲染端手里只有截到 200 字的 compacted 事件，所以草稿必须由引擎从库里取
    const longSummary = 'S1' + '摘'.repeat(2990) + 'S1-END';
    store.appendCompactMarker(sessionId, longSummary, 'A0');
    addUser(store, sessionId, 'U-last', 'U-last：把报告改完');
    // 先调一次工具，工具结果以 role=user 落库；下一次请求才超窗——草稿里要的是用户的话，不是工具输出
    const small = new ModelProvider('small', [
      [{ kind: 'toolCallComplete', toolUseId: 'T1', name: 'echo', input: '{"text":"TOOL-OUT","tool_title":"回声"}' }, { kind: 'done', stopReason: 'toolUse' }],
      overflow400(),
    ]);
    const events = await collect(runAgentLoop(store, {
      sessionId, provider: small, tools, toolContext, systemPrompt: 'sys', retryDelaysMs: [0], contextPolicy: policy,
    }));
    const last = events.at(-1) as { kind: string; code?: string; relayDraft?: string };
    expect(last.code).toBe('contextFull');
    const draft = last.relayDraft ?? '';
    expect(draft).toContain(longSummary);
    expect(draft).toContain('U-last：把报告改完');
    expect(draft).not.toContain('TOOL-OUT');
    expect(draft).not.toContain('最早的请求');
  });

  it('⑦ 回归：400 但文本是限流（too many tokens + rate limit）时仍按老路径降级到 peer，reason 是原文、不带 cause', async () => {
    const { store, tools, toolContext, sessionId } = mkCtx();
    addUser(store, sessionId, 'U1', 'x');
    const small = new ModelProvider('small', [new ProviderError('rate limit exceeded: too many tokens', { status: 400 })]);
    const peer = new ModelProvider('peer', [reply('peer 接手')]);
    const events = await collect(runAgentLoop(store, {
      sessionId, provider: small, tools, toolContext, systemPrompt: 'sys', retryDelaysMs: [0],
      contextPolicy: policy, primaryLabel: 'small', fallbackChain: [{ provider: peer, label: 'peer' }],
    }));
    expect(events.filter(e => e.kind === 'fallback')).toEqual([
      { kind: 'fallback', from: 'small', to: 'peer', reason: 'rate limit exceeded: too many tokens' },
    ]);
    expect(peer.calls).toBe(1);
    expect(events.at(-1)).toEqual({ kind: 'turnEnd', stopReason: 'endTurn' });
  });

  it('⑧ thinkingBinding 同在捕获处拦截：不降级，原样报错并带 code', async () => {
    const { store, tools, toolContext, sessionId } = mkCtx();
    addUser(store, sessionId, 'U1', 'x');
    const main = new ModelProvider('small', [new ProviderError('Claude 拒绝回放历史思考块：请新建会话继续', { status: 400, code: 'thinkingBinding' })]);
    const backup = new ModelProvider('big', [reply('不该走到')]);
    const events = await collect(runAgentLoop(store, {
      sessionId, provider: main, tools, toolContext, systemPrompt: 'sys', retryDelaysMs: [0],
      contextPolicy: policy, fallbackChain: [{ provider: backup, label: 'backup' }],
    }));
    expect(events.some(e => e.kind === 'fallback')).toBe(false);
    expect(backup.calls).toBe(0);
    expect(events.at(-1)).toEqual({ kind: 'error', code: 'thinkingBinding', message: 'Claude 拒绝回放历史思考块：请新建会话继续' });
  });
});

// ── ⑨ relayDraft 的拼法与上限 ──

describe('W2a-2 ⑨ buildRelayDraft：摘要加最后的请求，封顶 8000 字', () => {
  const history = (store: ChatStore, sid: string): RawMessage[] => store.listMessages(sid);

  it('没有摘要时写明还没有摘要；最后的请求截到 2000 字', () => {
    const { store, sessionId } = mkCtx();
    addUser(store, sessionId, 'U1', 'Q'.repeat(5000));
    const d = buildRelayDraft(store, sessionId, history(store, sessionId));
    expect(d.startsWith('接续上一个会话（上下文已满）。')).toBe(true);
    expect(d).toContain('（上一会话还没有生成摘要）');
    expect(d).toContain('Q'.repeat(2000));
    expect(d).not.toContain('Q'.repeat(2001));
  });

  it('旧版本写下的「[摘要为空]」marker 不当摘要用', () => {
    const { store, sessionId } = mkCtx();
    addUser(store, sessionId, 'U1', '问题');
    store.appendCompactMarker(sessionId, '[摘要为空]', 'U1');
    addUser(store, sessionId, 'U2', '最后的问题');
    const d = buildRelayDraft(store, sessionId, history(store, sessionId));
    expect(d).toContain('（上一会话还没有生成摘要）');
    expect(d).not.toContain('[摘要为空]');
    expect(d).toContain('最后的问题');
  });

  it('摘要再长也封顶 8000 字，最后的请求完整保住，截断处不切断代理对', () => {
    const { store, sessionId } = mkCtx();
    addUser(store, sessionId, 'U1', '问题');
    store.appendCompactMarker(sessionId, 'HEAD' + '😀'.repeat(20000), 'U1');
    addUser(store, sessionId, 'U2', 'LAST-ASK');
    const d = buildRelayDraft(store, sessionId, history(store, sessionId));
    expect(RELAY_DRAFT_MAX).toBe(8000);
    expect(d.length).toBeLessThanOrEqual(8000);
    expect(d).toContain('HEAD');
    expect(d).toContain('LAST-ASK');
    // 没有孤立的代理项（孤立代理项进了输入框再发出去，严格的 JSON 端会 400）
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(d)).toBe(false);
  });
});

// ── ⑩ 集成：真 provider + 本地假 OpenAI 端点 ──

describe('W2a-2 ⑩ 集成：组内同窗口不白打，大窗口接手后照旧改绑', () => {
  let mock: Server;
  let mockPort = 0;
  const hits: string[] = [];

  beforeAll(async () => {
    mock = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        hits.push(String(req.url));
        if (req.url?.startsWith('/overflow/')) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: "This model's maximum context length is 131072 tokens. However, you requested 140000 tokens." } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '大窗口接手' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
        res.end('data: [DONE]\n\n');
      });
    });
    await new Promise<void>(r => mock.listen(0, '127.0.0.1', () => r()));
    mockPort = (mock.address() as { port: number }).port;
  });
  afterAll(() => new Promise<void>(r => mock.close(() => r())));

  let stop: (() => Promise<void>) | undefined;
  const savedFake = process.env.DESKMINIS_FAKE_PROVIDER;
  afterEach(async () => {
    await stop?.(); stop = undefined;
    if (savedFake === undefined) delete process.env.DESKMINIS_FAKE_PROVIDER; else process.env.DESKMINIS_FAKE_PROVIDER = savedFake;
  });

  async function boot() {
    const dataDir = mkdtempSync(join(tmpdir(), 'dm-w2a2-'));
    process.env.DESKMINIS_TEST = '1';
    delete process.env.DESKMINIS_FAKE_PROVIDER; // 组成员必须是真 provider
    const srv = await startMinisd({ dataDir, host: '127.0.0.1', port: 0 });
    stop = srv.close;
    return srv;
  }

  function rpcClient(port: number, token: string) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
    let idc = 0;
    const pending = new Map<number, (v: any) => void>();
    const notifications: { method: string; params: any }[] = [];
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data));
      if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)!(msg); pending.delete(msg.id); }
      else if (msg.method) notifications.push({ method: msg.method, params: msg.params });
    });
    const ready = new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
    const call = (method: string, params?: unknown): Promise<any> => {
      const id = ++idc;
      return new Promise((res) => { pending.set(id, res); ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); });
    };
    return { ready, call, notifications, close: () => ws.close() };
  }

  async function waitFor(what: string, cond: () => boolean, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
      await new Promise(r => setTimeout(r, 10));
    }
  }

  const eventsSince = (c: ReturnType<typeof rpcClient>, mark: number) =>
    c.notifications.slice(mark).filter(n => n.method === 'chat.event').map(n => n.params?.event);

  /** 建一个两成员的组并把新会话绑上去；成员窗口用设置里的手动 contextWindow 注入。 */
  async function seedGroup(c: ReturnType<typeof rpcClient>, second: { path: string; modelId: string; contextWindow: number }) {
    const a = (await c.call('provider.instances.create', { name: '主力', kind: 'ollama', baseUrl: `http://127.0.0.1:${mockPort}/overflow/v1`, modelId: 'mock-a', contextWindow: 128_000 })).result;
    const b = (await c.call('provider.instances.create', { name: '备用', kind: 'ollama', baseUrl: `http://127.0.0.1:${mockPort}${second.path}/v1`, modelId: second.modelId, contextWindow: second.contextWindow })).result;
    const g = (await c.call('modelgroup.create', { name: '主备', memberIds: [a.id, b.id] })).result;
    const s = (await c.call('chat.sessions.create', {})).result;
    await c.call('chat.sessions.rename', { sessionId: s.id, title: '改过名的会话' });
    await c.call('chat.sessions.setModelBinding', { sessionId: s.id, binding: `group:${g.id}` });
    return { a, b, g, s };
  }

  it('组 [A 128K, B 128K]，A 回 DeepSeek 式超窗 400：B 一次没请求、绑定仍是组、收到 contextFull 与接力草稿', async () => {
    hits.length = 0;
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const { g, s } = await seedGroup(c, { path: '/peer', modelId: 'mock-b', contextWindow: 128_000 });

    const mark = c.notifications.length;
    const r = await c.call('chat.prompt', { sessionId: s.id, text: '接力要带上这句话' });
    expect(r.error).toBeUndefined();
    await waitFor('回合结束', () => eventsSince(c, mark).some(e => e?.kind === 'turnEnd' || e?.kind === 'error'), 15000);

    const evs = eventsSince(c, mark);
    expect(evs.some(e => e?.kind === 'fallback')).toBe(false);
    expect(hits).toEqual(['/overflow/v1/chat/completions']);
    const err = evs.find(e => e?.kind === 'error');
    expect(err?.code).toBe('contextFull');
    expect(err?.message).toContain('上下文已满');
    expect(String(err?.relayDraft)).toContain('接力要带上这句话');
    const list = (await c.call('chat.sessions.list')).result;
    expect(list.find((x: { id: string }) => x.id === s.id)?.modelBinding).toBe(`group:${g.id}`);
    c.close();
  });

  it('组 [A 128K, C 1M]：因上下文已满降级到 C，C 跑通后照旧改绑到 C', async () => {
    hits.length = 0;
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const { b, s } = await seedGroup(c, { path: '/ok', modelId: 'mock-c', contextWindow: 1_000_000 });

    const mark = c.notifications.length;
    await c.call('chat.prompt', { sessionId: s.id, text: '你好' });
    await waitFor('回合结束', () => eventsSince(c, mark).some(e => e?.kind === 'turnEnd' || e?.kind === 'error'), 15000);

    const evs = eventsSince(c, mark);
    expect(evs.find(e => e?.kind === 'error')).toBeUndefined();
    expect(evs.find(e => e?.kind === 'fallback')).toEqual({
      kind: 'fallback', from: '主力(mock-a)', to: '备用(mock-c)', reason: '上下文已满', cause: 'contextOverflow',
    });
    expect(hits).toEqual(['/overflow/v1/chat/completions', '/ok/v1/chat/completions']);
    // 改绑在 turnEnd 广播之前同步落库（index.ts 的事件循环），看到 turnEnd 时绑定已经改好
    const list = (await c.call('chat.sessions.list')).result;
    expect(list.find((x: { id: string }) => x.id === s.id)?.modelBinding).toBe(`provider:${b.id}`);
    c.close();
  });
});
