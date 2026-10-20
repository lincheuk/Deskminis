import { requestToolOutput } from './request-tool-output-fixture';
/**
 * F02 验收 1 / 3 / 5 的循环证据：真 runAgentLoop + 真 Provider 类 + 抓请求体的假端点（故障注入）。
 * 断言的是实际发出的请求体、事件序列与落库的 usage，不是只看预算函数的返回值。
 * 全用 ASCII 造大文本：应用的估算（CJK ÷1.6、其余 ÷4）与假端点的口径（JSON 长度 ÷4）才是同一个数。
 * 受控时序一律用闸门（测试持有的 promise），不用 sleep。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgentLoop, type LoopEvent, type ProviderSlot, type RunOptions } from '../src/minisd/agent/loop';
import { ContextPolicy } from '../src/minisd/agent/context-policy';
import { CompactEngine } from '../src/minisd/agent/compact';
import { openDb } from '../src/minisd/store/db';
import { ChatStore } from '../src/minisd/store/chat-store';
import { ToolRegistry } from '../src/minisd/tools/registry';
import type { ToolContext, ToolExecutor } from '../src/minisd/tools/types';
import { MinisPaths } from '../src/minisd/paths';
import { ModelCatalog } from '../src/minisd/providers/model-catalog';
import { resolveRuntimeModel, type RuntimeModelInput } from '../src/minisd/providers/runtime-model';
import { AnthropicProvider } from '../src/minisd/providers/anthropic';
import { OpenAIProvider } from '../src/minisd/providers/openai';
import { GeminiProvider } from '../src/minisd/providers/gemini';
import { ProviderError, type AgentProvider, type FetchLike, type StreamRequest } from '../src/minisd/providers/types';
import type { AgentStreamEvent, ContentPart, RawMessage } from '../src/shared/types';
import type { RequestBudget } from '../src/shared/request-budget';
import { fixedCostMessage } from '../src/minisd/agent/request-budget';
import { EXAMPLE_APIS, catalogFixtureF02, jsonResponse } from './runtime-model-fixture';
import { pngBytes } from './image-fixtures';

/** L20 的故障注入：让循环用到的 computeSlotBudget 抛错。开关默认关，其余用例走真实现。 */
const fault = vi.hoisted(() => ({ throwBudget: false }));
vi.mock('../src/minisd/agent/request-budget', async importOriginal => {
  const orig = await importOriginal<typeof import('../src/minisd/agent/request-budget')>();
  return {
    ...orig,
    computeSlotBudget: (a: Parameters<typeof orig.computeSlotBudget>[0]) => {
      if (fault.throwBudget) throw new Error('budget boom (injected)');
      return orig.computeSlotBudget(a);
    },
  };
});

let dir: string;
let catalog: ModelCatalog;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dm-budget-loop-'));
  catalog = new ModelCatalog(join(dir, 'catalog.json'), async () => jsonResponse(catalogFixtureF02()));
  await catalog.refresh(true);
});
afterEach(() => { fault.throwBudget = false; vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

const RELAY = 'https://relay.example/v1';
/** 中转上目录未收录的型号 + 手动窗口：窗口是硬来源（manual），输出上限落到 min(8192, 窗口的 3/4)。 */
const relay = (contextWindow: number, extra: Partial<RuntimeModelInput> = {}): RuntimeModelInput =>
  ({ id: 'inst-relay', kind: 'openai-compat', baseUrl: RELAY, modelId: 'unlisted-model', contextWindow, ...extra });
const IND: RuntimeModelInput = { id: 'inst-ind', kind: 'openai-compat', baseUrl: EXAMPLE_APIS.vendorA, modelId: 'ind-model' };

const echoTool: ToolExecutor = {
  definition: { name: 'echo', description: 'echo', parameters: { text: { type: 'string', description: 't' }, tool_title: { type: 'string', description: 't' } }, required: ['text', 'tool_title'] },
  async execute(input) { return { output: `echo:${String(input.text)}`, success: true }; },
};
/** 同名同参数的 echo，但每次返回 chars 个字符的大结果（长工具任务用）。 */
const bigEcho = (chars: number): ToolExecutor => ({
  definition: echoTool.definition,
  async execute() { return { output: ascii(chars), success: true }; },
});
const namedTool = (name: string, description = 'tool'): ToolExecutor => ({
  definition: { name, description, parameters: { tool_title: { type: 'string', description: 't' } }, required: ['tool_title'] },
  async execute() { return { output: 'ok', success: true }; },
});
const ascii = (n: number): string => 'lorem ipsum dolor sit amet '.repeat(Math.ceil(n / 27)).slice(0, n);
/** n 个带大段说明的工具：工具定义合计约 tokens 个 token。 */
const bigTools = (n: number, tokens: number): ToolExecutor[] =>
  Array.from({ length: n }, (_, i) => namedTool(`big_tool_${String(i).padStart(2, '0')}`, ascii(Math.floor(tokens * 4 / n) - 110)));

function mkCtx(opts: { store?: ChatStore; sessionId?: string; tools?: ToolExecutor[] } = {}) {
  const store = opts.store ?? new ChatStore(openDb(':memory:'));
  const sessionId = opts.sessionId ?? store.createSession().id;
  const tools = new ToolRegistry();
  for (const t of opts.tools ?? [echoTool]) tools.register(t);
  const paths = new MinisPaths(join(dir, 'root')); paths.ensureSessionDirs(sessionId);
  const toolContext: ToolContext = { sessionId, paths, permissions: { async check() { return 'allow'; }, hasBridgeGrant: () => false } };
  // listMessages 按 (created_at, id) 排序、nowEpoch 只到毫秒：同一毫秒里连着追加会按随机 id 排，这里给严格递增的时间
  let at = store.nowEpoch();
  const add = (role: 'user' | 'assistant', parts: ContentPart[], extra: Partial<RawMessage> = {}) =>
    store.appendMessage({ id: store.newId(), sessionId, role, parts, createdAt: (at += 0.01), streamInterruptCount: 0, ...extra });
  const say = (text: string) => add('user', [{ type: 'text', value: text }]);
  /** 一串工具调用回合：sizes[i] 是第 i 轮工具结果的字符数。 */
  const rounds = (prefix: string, sizes: number[]) => sizes.forEach((size, i) => {
    add('assistant', [{ type: 'toolUse', value: { toolUseId: `${prefix}${i + 1}`, name: 'echo', input: `{"text":"r${i + 1}","tool_title":"t"}` } }]);
    add('user', [{ type: 'toolResult', value: { toolUseId: `${prefix}${i + 1}`, output: ascii(size), success: true, status: 'success' } }]);
  });
  const file = (name: string, bytes: Uint8Array): ContentPart => {
    writeFileSync(join(paths.sessionBucket(sessionId, 'attachments'), name), bytes);
    return { type: 'mediaRef', value: { id: name, relativePath: `attachments/${name}`, mimeType: name.endsWith('.png') ? 'image/png' : 'image/jpeg' } };
  };
  const assistants = () => store.listMessages(sessionId).filter(m => m.role === 'assistant');
  return { store, tools, toolContext, sessionId, add, say, rounds, file, assistants };
}
type Ctx = ReturnType<typeof mkCtx>;
type Body = Record<string, any>;

/** 抓请求体的 fetch（应答可以看请求体、序号与取消信号）。 */
function captureBody(respond: (body: Body, n: number, init: { signal?: AbortSignal }) => Response | Promise<Response>) {
  const hits: { url: string; body: Body }[] = [];
  const fetchImpl = (async (url: unknown, init?: { body?: unknown; signal?: AbortSignal }) => {
    const body = JSON.parse(String(init?.body)) as Body;
    hits.push({ url: String(url), body });
    return respond(body, hits.length - 1, { signal: init?.signal });
  }) as unknown as FetchLike;
  return { hits, fetchImpl };
}
const sse = (frames: unknown[], done: boolean) =>
  new Response(frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : ''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
/** OpenAI 兼容端点的一次回复；usage 给了就在末帧（choices 为空数组）带上。 */
const openaiOk = (text: string, usage?: Record<string, unknown>, finish = 'stop') => sse([
  { choices: [{ index: 0, delta: { content: text } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: finish }] },
  ...(usage ? [{ choices: [], usage }] : []),
], true);
const openaiToolCall = (id: string, usage?: Record<string, unknown>, args = '{"text":"x","tool_title":"t"}', finish = 'tool_calls') => sse([
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, function: { name: 'echo', arguments: args } }] } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: finish }] },
  ...(usage ? [{ choices: [], usage }] : []),
], true);
const anthropicSse = (frames: Record<string, unknown>[]) =>
  new Response(frames.map(f => `event: ${String(f.type)}\ndata: ${JSON.stringify(f)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const anthropicOk = (text: string, inputTokens = 1) => anthropicSse([
  { type: 'message_start', message: { usage: { input_tokens: inputTokens, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
  { type: 'message_stop' },
]);
const anthropicToolCall = (id: string) => anthropicSse([
  { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name: 'echo' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"text":"x","tool_title":"t"}' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } },
  { type: 'message_stop' },
]);
/** 假端点估算输入的口径：请求体的 messages（含 system）与 tools 的 JSON 长度 ÷ 4。 */
const inputAllOf = (body: Body): number =>
  Math.ceil((JSON.stringify(body.messages ?? []).length + (body.tools ? JSON.stringify(body.tools).length : 0)) / 4);
/** Kimi 式的超限报文：overflow.ts 认得，归为 contextOverflow。 */
const tokenLimit400 = (limit: number, requested: number): Response =>
  new Response(JSON.stringify({ error: { message: `Invalid request: Your request exceeded model token limit: ${limit} (requested: ${requested})` } }), { status: 400 });
/** 按「系统提示 + 工具 + 消息 + max_tokens ≤ 窗口」校验的端点。 */
const strictAll = (limit: number, reply: (body: Body, n: number) => Response = () => openaiOk('ok')) => (body: Body, n: number): Response => {
  const requested = Number(body.max_tokens ?? 0) + inputAllOf(body);
  return requested > limit ? tokenLimit400(limit, requested) : reply(body, n);
};
/** 收下任何请求并在末帧回 usage.prompt_tokens：造「端点收下了比资料上限更大的输入」的样本。 */
const acceptWithUsage = (promptTokens: number) => (): Response => openaiOk('ok', { prompt_tokens: promptTokens, completion_tokens: 7, total_tokens: promptTokens + 7 });
const isSummaryRequest = (body: Body): boolean => body.messages?.[0]?.role === 'system' && body.messages[0].content === '你是对话摘要助手。';
const SUMMARY_TEXT = 'Summary: the user asked to read parts 1-3 of the build log; every part looked fine and no warnings were found.';
const openai = (input: RuntimeModelInput, fetchImpl: FetchLike) =>
  new OpenAIProvider({ apiKey: 'k', modelId: input.modelId, baseUrl: input.baseUrl!, fetchImpl });
/** 事件序列的简写（失败时直接看得到走了哪条路）。 */
const kindsOf = (events: LoopEvent[]): string[] => events.map(e =>
  e.kind === 'fallback' ? `fallback:${e.cause ?? 'failure'}` : e.kind === 'error' ? `error:${e.code ?? e.message}` : e.kind);
const errorsOf = (events: LoopEvent[]) => events.filter((e): e is Extract<LoopEvent, { kind: 'error' }> => e.kind === 'error');
/** 请求体里各条工具结果的正文（OpenAI 形态：role=tool 的消息）。 */
const toolOutputs = (body: Body): string[] => (body.messages as Body[]).filter(m => m.role === 'tool').map(m => requestToolOutput(m.content));
/** 测试持有的闸门。 */
function gate() { let open!: () => void; const wait = new Promise<void>(r => { open = r; }); return { wait, open }; }

interface RunSpec {
  primary: { provider: AgentProvider; input?: RuntimeModelInput };
  fallback?: { provider: AgentProvider; input?: RuntimeModelInput }[];
  systemPrompt?: RunOptions['systemPrompt'];
  /** 接上水位与压缩（真 ContextPolicy 与真 CompactEngine，调用方可以先装探针）。 */
  context?: { policy: ContextPolicy; engine: CompactEngine };
  extra?: Partial<RunOptions>;
  /** 回调收到的预算对象往这里放（应答函数要在请求进行中读它时由调用方传入）。 */
  budgets?: RequestBudget[];
}
/** 跑一次运行，收集事件与 onRequestBudget 回调收到的对象。 */
async function run(ctx: Ctx, spec: RunSpec): Promise<{ events: LoopEvent[]; budgets: RequestBudget[] }> {
  const chain: ProviderSlot[] = (spec.fallback ?? []).map((f, i) => ({
    provider: f.provider, label: `备用${i + 1}`, ...(f.input ? { runtime: resolveRuntimeModel(f.input, catalog) } : {}),
  }));
  const events: LoopEvent[] = [];
  const budgets = spec.budgets ?? [];
  for await (const e of runAgentLoop(ctx.store, {
    sessionId: ctx.sessionId, tools: ctx.tools, toolContext: ctx.toolContext, systemPrompt: spec.systemPrompt ?? 'sys', retryDelaysMs: [0],
    provider: spec.primary.provider, primaryLabel: '主力',
    ...(spec.primary.input ? { primaryRuntime: resolveRuntimeModel(spec.primary.input, catalog) } : {}),
    fallbackChain: chain,
    ...(spec.context ? { contextPolicy: spec.context.policy, compactEngine: spec.context.engine } : {}),
    onRequestBudget: b => { budgets.push(b); },
    ...spec.extra,
  })) events.push(e);
  return { events, budgets };
}
const realContext = (ctx: Ctx) => ({ policy: new ContextPolicy(catalog), engine: new CompactEngine(ctx.store) });
const TURN_END = { kind: 'turnEnd', stopReason: 'endTurn' };

describe('验收 1：系统提示与工具很大、历史很短时提前识别预算不足', () => {
  it('L1 固定开销连下界都放不下手动窗口：一次请求都不发，报 requestBudget 并说明固定开销', async () => {
    const ctx = mkCtx();
    ctx.say('hi');
    const cfg = relay(32_000);
    const ep = captureBody(() => openaiOk('ok'));
    const context = realContext(ctx);
    const summarize = vi.spyOn(context.engine, 'summarize');
    const { events, budgets } = await run(ctx, { primary: { provider: openai(cfg, ep.fetchImpl), input: cfg }, systemPrompt: ascii(200_000), context });

    expect(ep.hits).toHaveLength(0);
    const last = events.at(-1) as Extract<LoopEvent, { kind: 'error' }>;
    expect(kindsOf(events)).toEqual(['error:requestBudget']);
    expect(last.budget?.status).toBe('blocked');
    expect(last.budget?.input.components.system).toBe(50_000);
    expect(last.budget?.input.components.tools).toBeGreaterThan(0);
    // 文案说的是固定开销：带系统提示与工具定义的数字，说明没有发送
    expect(last.message).toContain(`系统提示约 ${last.budget!.input.components.system}`);
    expect(last.message).toContain(`工具定义约 ${last.budget!.input.components.tools}`);
    expect(last.message).toContain('本轮没有发送给任何模型');
    expect('relayDraft' in last).toBe(false);
    // 不为放不下的固定开销发付费的摘要请求；没有发出请求就没有预算回调，也没有新增 assistant 消息
    expect(summarize).not.toHaveBeenCalled();
    expect(budgets).toEqual([]);
    expect(ctx.assistants()).toEqual([]);
  });

  it('L2 主力放不下固定开销、组里有放得下的成员：主力一次请求都不发，按 requestBudget 换到备用', async () => {
    const ctx = mkCtx();
    ctx.say('hi');
    const small = relay(32_000); const big = relay(1_000_000, { id: 'inst-big' });
    const main = captureBody(() => openaiOk('never'));
    const backup = captureBody(() => openaiOk('from backup'));
    const { events, budgets } = await run(ctx, {
      primary: { provider: openai(small, main.fetchImpl), input: small },
      fallback: [{ provider: openai(big, backup.fetchImpl), input: big }],
      systemPrompt: ascii(200_000),
    });
    expect(main.hits).toHaveLength(0);
    expect(backup.hits).toHaveLength(1);
    expect(kindsOf(events)).toEqual(['fallback:requestBudget', 'textDelta', 'messagePersisted', 'turnEnd']);
    expect(events[0]).toMatchObject({ kind: 'fallback', from: '主力', to: '备用1', cause: 'requestBudget' });
    expect((events[0] as { reason: string }).reason).toContain('放不下这次请求的固定部分');
    expect(events.at(-1)).toEqual(TURN_END);
    // 预算回调只为真正发出请求的备用调一次
    expect(budgets).toHaveLength(1);
    expect(budgets[0].slot.label).toBe('备用1');
    expect(budgets[0].limits.inputLimit).toBe(1_000_000);
  });

  it('L3 估计值超过窗口、下界没超过（over）：照发；端点以超窗拒绝后报 requestBudget 说明固定开销，不给接力草稿', async () => {
    const ctx = mkCtx();
    ctx.say('hi');
    const cfg = relay(32_000);
    const ep = captureBody(strictAll(32_000));
    const { events, budgets } = await run(ctx, { primary: { provider: openai(cfg, ep.fetchImpl), input: cfg }, systemPrompt: ascii(176_000) });
    expect(ep.hits).toHaveLength(1);
    expect(ep.hits[0].body.max_tokens).toBe(1_024);
    expect(budgets).toHaveLength(1);
    expect(budgets[0].status).toBe('over');
    expect(budgets[0].output).toMatchObject({ requested: 1_024, limitedBy: 'floor' });
    expect(kindsOf(events)).toEqual(['error:requestBudget']);
    const last = errorsOf(events)[0];
    expect(last.budget).toEqual(budgets[0]);
    expect('relayDraft' in last).toBe(false);
    expect(last.message).toContain('主力 拒绝了这次请求');
    expect(last.message).toContain(`系统提示约 ${budgets[0].input.components.system}`);
    expect(last.message).toContain(`工具定义约 ${budgets[0].input.components.tools}`);
    expect(last.message).not.toContain('本轮没有发送');
    expect(events.some(e => e.kind === 'error' && e.code === 'contextFull')).toBe(false);
    expect(ctx.assistants()).toEqual([]);
  });

  it('L3b 端点收下了比资料上限更大的输入：下一次运行不再据此收紧输出，更不会被本地拒发', async () => {
    const ctx = mkCtx();
    ctx.say('hi');
    const cfg = relay(32_000);
    const ep = captureBody(acceptWithUsage(44_000));
    const spec = { primary: { provider: openai(cfg, ep.fetchImpl), input: cfg }, systemPrompt: ascii(176_000) };
    const first = await run(ctx, spec);
    expect(ep.hits).toHaveLength(1);
    expect(ep.hits[0].body.max_tokens).toBe(1_024);
    expect(first.budgets[0].status).toBe('over');
    expect(first.events.at(-1)).toEqual(TURN_END);
    expect(ctx.assistants()[0].tokenUsage?.inputTokens).toBe(44_000);

    ctx.say('next question');
    const second = await run(ctx, spec);
    expect(ep.hits).toHaveLength(2);
    expect(second.budgets).toHaveLength(1);
    expect(second.budgets[0].limits).toMatchObject({ windowKnown: false, observedAbove: 44_000, inputLimit: 32_000 });
    expect(second.budgets[0].status).toBe('ok');
    expect(ep.hits[1].body.max_tokens).toBe(8_192);
    expect(second.events.at(-1)).toEqual(TURN_END);
    // 全程没有 requestBudget（既没有拒发的错误，也没有据此换槽位）
    expect(kindsOf([...first.events, ...second.events]).some(k => k.includes('requestBudget'))).toBe(false);
    expect(errorsOf([...first.events, ...second.events])).toEqual([]);
  });

  it('L3c 对照：系统提示很短、对话本身放不下：仍报「上下文已满」并给接力草稿，不说成固定开销', async () => {
    const ctx = mkCtx();
    // F03：放不下的那 16 万字符放在用户消息里（裁不了）。原夹具是一条 16 万字符的工具结果——那种请求现在会被裁成头尾后
    // 在同一模型上恢复（tests/overflow-recovery-loop.test.ts 的 K4）；这条用例钉的是「对话本身放不下」，断言不变
    ctx.say(`summarize the log ${ascii(160_000)}`);
    const cfg = relay(32_000);
    const ep = captureBody(strictAll(32_000));
    const { events } = await run(ctx, { primary: { provider: openai(cfg, ep.fetchImpl), input: cfg }, context: realContext(ctx) });
    expect(ep.hits).toHaveLength(1);
    const last = events.at(-1) as Extract<LoopEvent, { kind: 'error' }>;
    expect(last).toMatchObject({ kind: 'error', code: 'contextFull' });
    expect(last.relayDraft).toContain('summarize the log');
    expect('budget' in last).toBe(false);
  });

  it('L4 工具定义约 4 万 token、历史一句话：max_tokens 收紧到剩余空间，按窗口校验的端点收下', async () => {
    const ctx = mkCtx({ tools: [echoTool, ...bigTools(60, 40_000)] });
    ctx.say('hi');
    const cfg = relay(64_000, { maxOutputTokens: 30_000 });
    const ep = captureBody(strictAll(64_000));
    const { events, budgets } = await run(ctx, { primary: { provider: openai(cfg, ep.fetchImpl), input: cfg } });
    expect(events.at(-1)).toEqual(TURN_END);
    expect(ep.hits).toHaveLength(1);
    expect(budgets).toHaveLength(1);
    expect(budgets[0].input.components.tools).toBeGreaterThan(39_000);
    expect(budgets[0].input.toolCount).toBe(61);
    expect(ep.hits[0].body.max_tokens).toBe(budgets[0].output.requested);
    expect(ep.hits[0].body.max_tokens).toBeLessThan(30_000);
    expect(ep.hits[0].body.max_tokens).toBeGreaterThan(15_000);
    expect(budgets[0].output.limitedBy).toBe('window');
    expect(budgets[0].output.preferenceSource).toBe('manual');
  });
});

describe('验收 3：共享窗口与独立上限；降级到小窗口后重新预算并遵守最大输出', () => {
  it('L5 同样数字的 Gemini 槽位：输入与输出各按各的上限，maxOutputTokens 不随输入收紧', async () => {
    const ctx = mkCtx({ tools: [echoTool, ...bigTools(60, 40_000)] });
    ctx.say('hi');
    const cfg: RuntimeModelInput = { id: 'inst-gem', kind: 'gemini', baseUrl: 'https://gem-relay.example', modelId: 'unlisted-gem', contextWindow: 64_000, maxOutputTokens: 30_000 };
    const hits: Body[] = [];
    const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body)) as Body;
      hits.push(body);
      // 分别校验输入上限与输出上限
      const input = Math.ceil(JSON.stringify([body.contents, body.tools, body.system_instruction]).length / 4);
      if (input > 64_000 || body.generationConfig.maxOutputTokens > 30_000) return new Response('{"error":{"message":"limit"}}', { status: 400 });
      return new Response(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 } })}\n\n`, { status: 200 });
    }) as unknown as FetchLike;
    const { events, budgets } = await run(ctx, { primary: { provider: new GeminiProvider({ apiKey: 'k', modelId: cfg.modelId, baseUrl: cfg.baseUrl, fetchImpl }), input: cfg } });
    expect(events.at(-1)).toEqual(TURN_END);
    expect(hits).toHaveLength(1);
    expect(hits[0].generationConfig.maxOutputTokens).toBe(30_000);
    expect(budgets[0].limits).toMatchObject({ kind: 'separate', basis: 'adapter-separate', inputLimit: 64_000 });
    expect(budgets[0].output.requested).toBe(30_000);
  });

  it('L6 目录给了独立输入上限的型号：输入 24 万时 max_tokens 仍是任务偏好 128000（共享窗口的算法会收紧到 124000）', async () => {
    const ctx = mkCtx();
    ctx.say('read it');
    ctx.rounds('T', [960_000]);
    const ep = captureBody(body => inputAllOf(body) > 272_000 ? tokenLimit400(272_000, inputAllOf(body)) : openaiOk('ok'));
    const { events, budgets } = await run(ctx, { primary: { provider: openai(IND, ep.fetchImpl), input: IND }, extra: { outputPreference: 128_000 } });
    expect(events.at(-1)).toEqual(TURN_END);
    expect(events.some(e => e.kind === 'fallback')).toBe(false);
    expect(ep.hits).toHaveLength(1);
    expect(ep.hits[0].body.max_tokens).toBe(128_000);
    expect(budgets[0].limits).toMatchObject({ kind: 'separate', inputLimit: 272_000 });
    expect(budgets[0].input.tokens).toBeGreaterThan(240_000);
    expect(budgets[0].status).toBe('ok');
    expect(budgets[0].output.preferenceSource).toBe('task');
  });

  it('L9 故障降级到小窗口的备用：按备用自己的窗口与上限重新预算，max_tokens 收紧到它的剩余空间', async () => {
    const ctx = mkCtx();
    ctx.say('read it');
    ctx.rounds('T', [200_000]);
    const big = relay(1_000_000, { id: 'inst-big' });
    const small = relay(64_000, { id: 'inst-small', maxOutputTokens: 16_000 });
    const main = captureBody(() => new Response(JSON.stringify({ error: { message: 'rate limited (mock)' } }), { status: 429 }));
    const backup = captureBody(strictAll(64_000));
    const { events, budgets } = await run(ctx, {
      primary: { provider: openai(big, main.fetchImpl), input: big },
      fallback: [{ provider: openai(small, backup.fetchImpl), input: small }],
    });
    expect(events.at(-1)).toEqual(TURN_END);
    expect(main.hits).toHaveLength(1);
    expect(backup.hits).toHaveLength(1);
    expect(budgets).toHaveLength(2);
    expect(budgets[0].limits.sharedWindow).toBe(1_000_000);
    expect(main.hits[0].body.max_tokens).toBe(budgets[0].output.requested);
    expect(budgets[1].slot.label).toBe('备用1');
    expect(budgets[1].limits.sharedWindow).toBe(64_000);
    expect(backup.hits[0].body.max_tokens).toBe(budgets[1].output.requested);
    expect(backup.hits[0].body.max_tokens).toBeLessThan(16_000);
    expect(backup.hits[0].body.max_tokens).toBeGreaterThan(6_000);
    expect(budgets[1].output.limitedBy).toBe('window');
  });

  it('L21 收紧 max_tokens 后推理预算跟着重算并给可见输出留底（budget_tokens = max_tokens − 1,024）；剩余空间放不下最小预算时不带 thinking，固定句只说一次', async () => {
    const cfg: RuntimeModelInput = {
      id: 'inst-claude-relay', kind: 'anthropic', baseUrl: 'https://claude-relay.example', modelId: 'claude-relay-x',
      contextWindow: 64_000, maxOutputTokens: 30_000, capabilityOverrides: { reasoning: true },
    };
    const anthropic = (fetchImpl: FetchLike) => new AnthropicProvider({ apiKey: 'k', modelId: cfg.modelId, baseUrl: cfg.baseUrl, fetchImpl });
    // 第一组：工具约 4 万 token
    const a = mkCtx({ tools: [echoTool, ...bigTools(60, 40_000)] });
    a.say('hi');
    const ep1 = captureBody(() => anthropicOk('ok'));
    const r1 = await run(a, { primary: { provider: anthropic(ep1.fetchImpl), input: cfg }, extra: { thinkingLevel: 'high' } });
    expect(r1.events.at(-1)).toEqual(TURN_END);
    const b1 = ep1.hits[0].body;
    expect(b1.max_tokens).toBe(r1.budgets[0].output.requested);
    expect(b1.max_tokens).toBeLessThan(30_000);
    expect(b1.thinking.type).toBe('enabled');
    // 被剩余空间收紧的 max_tokens：预算不顶到 max_tokens − 1，给正文与工具入参留出最小输出
    expect(r1.budgets[0].output.limitedBy).toBe('window');
    expect(b1.thinking.budget_tokens).toBe(b1.max_tokens - 1_024);
    // 第二组：工具约 5.7 万 token，剩余空间不足 1,025；端点先回一个工具调用再正常结束
    const b = mkCtx({ tools: [echoTool, ...bigTools(60, 57_000)] });
    b.say('hi');
    const ep2 = captureBody((_body, n) => n === 0 ? anthropicToolCall('toolu_1') : anthropicOk('done'));
    const r2 = await run(b, { primary: { provider: anthropic(ep2.fetchImpl), input: cfg }, extra: { thinkingLevel: 'high' } });
    expect(r2.events.at(-1)).toEqual(TURN_END);
    expect(ep2.hits).toHaveLength(2);
    for (const hit of ep2.hits) {
      expect(hit.body.max_tokens).toBe(1_024);
      expect('thinking' in hit.body).toBe(false);
    }
    const notices = r2.events.flatMap(e => e.kind === 'capability' ? e.notices : []);
    const fixed = '主力 的上下文剩余空间容不下最小推理预算，本轮未开启推理';
    expect(notices.filter(n => n === fixed)).toHaveLength(1);
    expect(fixed).not.toMatch(/\d/);
    expect(notices.some(n => /容不下最小推理预算/.test(n) && /\d/.test(n))).toBe(false);
  });

  it('L21b max_tokens 与模型上限的差来自偏好（任务指定 300 加推理预算）而不是剩余空间：推理预算照档位发，不为留底而缩', async () => {
    const cfg: RuntimeModelInput = { id: 'inst-claude', kind: 'anthropic', modelId: 'claude-x' };
    const ctx = mkCtx();
    ctx.say('hi');
    const ep = captureBody(() => anthropicOk('ok'));
    const { events, budgets } = await run(ctx, {
      primary: { provider: new AnthropicProvider({ apiKey: 'k', modelId: 'claude-x', fetchImpl: ep.fetchImpl }), input: cfg },
      extra: { thinkingLevel: 'low', outputPreference: 300 },
    });
    expect(events.at(-1)).toEqual(TURN_END);
    expect(budgets[0].output).toMatchObject({ preferenceSource: 'task', limitedBy: 'preference', requested: 300 + 8_192 });
    expect(ep.hits[0].body.max_tokens).toBe(300 + 8_192);
    expect(ep.hits[0].body.thinking).toMatchObject({ type: 'enabled', budget_tokens: 8_192 });
  });
});

describe('验收 1：回放推理与图片不被漏算', () => {
  it('L7 DeepSeek V4 的推理回放计入水位：parts 只占 25%，加上回放到了压缩档，压缩 1 次', async () => {
    const ctx = mkCtx();
    for (let i = 1; i <= 20; i++) {
      ctx.say(`question ${i}: ${ascii(1_560)}`);
      ctx.add('assistant', [{ type: 'text', value: `answer ${i}: ${ascii(1_560)}` }], { reasoningContent: ascii(6_000) });
    }
    ctx.say('keep going');
    const cfg = relay(64_000, { modelId: 'deepseek-v4-pro' });
    const ep = captureBody(body => isSummaryRequest(body) ? openaiOk(SUMMARY_TEXT) : openaiOk('ok'));
    const context = realContext(ctx);
    const decide = vi.spyOn(context.policy, 'decideWindow');
    const { events, budgets } = await run(ctx, { primary: { provider: openai(cfg, ep.fetchImpl), input: cfg }, context });
    expect(events.filter(e => e.kind === 'compacted')).toHaveLength(1);
    expect(events.at(-1)).toEqual(TURN_END);
    // 第一次判水位时的输入：parts 约 1.6 万，回放约 3 万
    const [capacity, tokens] = decide.mock.calls[0];
    expect(capacity).toBe(64_000);
    expect(tokens).toBeGreaterThan(44_800);
    expect(context.policy.estimateTokens(ctx.store.listMessages(ctx.sessionId).slice(0, 41).map(m => ({ role: m.role, parts: m.parts })))).toBeLessThan(18_000);
    // 压缩后的正式请求：回放推理仍在预算里分列
    expect(budgets).toHaveLength(1);
    expect(budgets[0].input.components.reasoningReplay).toBeGreaterThan(0);
    expect(ep.hits.filter(h => isSummaryRequest(h.body))).toHaveLength(1);
  });

  it('L25 带图的用户消息：图片按尺寸计入预算，请求体里仍是完整的 base64，落库的估计带图片一项', async () => {
    const ctx = mkCtx();
    const png = pngBytes(1000, 1000, 300_000);
    ctx.add('user', [{ type: 'text', value: 'what is in this picture' }, ctx.file('shot.png', png)]);
    const cfg: RuntimeModelInput = { id: 'inst-claude', kind: 'anthropic', modelId: 'claude-x' };
    const ep = captureBody(() => anthropicOk('a picture', 1_400));
    const { events, budgets } = await run(ctx, { primary: { provider: new AnthropicProvider({ apiKey: 'k', modelId: 'claude-x', fetchImpl: ep.fetchImpl }), input: cfg } });
    expect(events.at(-1)).toEqual(TURN_END);
    expect(budgets).toHaveLength(1);
    expect(budgets[0].input.components.media).toBe(1_296);
    expect(budgets[0].input.imageCount).toBe(1);
    expect(budgets[0].input.mediaBasis).toBe('formula');
    expect(budgets[0].input.components.history).toBeLessThan(500);
    const image = (ep.hits[0].body.messages[0].content as Body[]).find(b => b.type === 'image')!;
    expect(image.source.data).toBe(png.toString('base64'));
    expect(image.source.data.length).toBe(400_000);
    const usage = ctx.assistants()[0].tokenUsage!;
    expect(usage.estimate).toEqual({ text: budgets[0].input.raw.text, media: 1_296, input: budgets[0].input.tokens });
    expect(usage.inputTokens).toBe(1_400);
  });
});

describe('验收 5：水位、压缩触发、最终请求用同一个预算；修剪是第一道', () => {
  it('L8 水位是固定开销撑起来的（75%）、可压部分只有几百 token：不为它发付费的摘要请求', async () => {
    const ctx = mkCtx();
    for (let i = 1; i <= 5; i++) { ctx.say(`q${i}`); ctx.add('assistant', [{ type: 'text', value: `a${i}` }]); }
    ctx.say('q6');
    const cfg = relay(64_000);
    const ep = captureBody(() => openaiOk('ok'));
    const context = realContext(ctx);
    const summarize = vi.spyOn(context.engine, 'summarize');
    const decide = vi.spyOn(context.policy, 'decideWindow');
    const { events, budgets } = await run(ctx, { primary: { provider: openai(cfg, ep.fetchImpl), input: cfg }, systemPrompt: ascii(192_000), context });
    // 前置：水位档位确实是压缩档
    expect(decide.mock.results[0].value).toBe('compact');
    expect(summarize).not.toHaveBeenCalled();
    expect(events.some(e => e.kind === 'compacted' || e.kind === 'compactFailed')).toBe(false);
    expect(ep.hits).toHaveLength(1);
    expect(events.at(-1)).toEqual(TURN_END);
    expect(budgets[0].input.components.system).toBe(48_000);
  });

  it('L10 一轮里判水位的两个入参、请求体的 max_tokens、回调对象、落库的估计与来源出自同一个预算', async () => {
    const ctx = mkCtx();
    ctx.say('hello there');
    const ep = captureBody(() => openaiOk('ok', { prompt_tokens: 320, completion_tokens: 4, total_tokens: 324 }));
    const context = realContext(ctx);
    const decide = vi.spyOn(context.policy, 'decideWindow');
    const { events, budgets } = await run(ctx, { primary: { provider: openai(IND, ep.fetchImpl), input: IND }, context });
    expect(events.at(-1)).toEqual(TURN_END);
    expect(budgets).toHaveLength(1);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide.mock.calls[0]).toEqual([budgets[0].limits.inputLimit, budgets[0].input.tokens]);
    expect(budgets[0].limits.inputLimit).toBe(272_000);
    // 默认偏好生效：模型上限 128000，单次请求申请 65536
    expect(ep.hits[0].body.max_tokens).toBe(budgets[0].output.requested);
    expect(ep.hits[0].body.max_tokens).toBe(65_536);
    expect(budgets[0].output).toMatchObject({ cap: 128_000, preference: 65_536, preferenceSource: 'default', limitedBy: 'preference' });
    const usage = ctx.assistants()[0].tokenUsage!;
    expect(usage.estimate?.input).toBe(budgets[0].input.tokens);
    expect(usage.source).toEqual({ by: 'provider', protocol: 'openai-chat', modelId: 'ind-model', instanceId: 'inst-ind' });
    expect(usage.v).toBe(2);
    // 收录端点自己的价格（输入 1.25、输出 10，每百万 token）：费用按当次槽位估算
    expect(usage.cost).toEqual({ status: 'estimated', usd: (320 * 1.25 + 4 * 10) / 1_000_000 });
  });

  it('L22 余量不足（tight）而水位没到档：先修剪，修剪后余量够了就不压缩', async () => {
    const ctx = mkCtx();
    ctx.say('run the nine steps');
    ctx.rounds('T', [24_000, 24_000, 60, 60, 60, 60, 60, 60, 36_000]);
    const cfg = relay(32_000);
    const ep = captureBody(() => openaiOk('ok'));
    const context = realContext(ctx);
    const summarize = vi.spyOn(context.engine, 'summarize');
    const decide = vi.spyOn(context.policy, 'decideWindow');
    const { events, budgets } = await run(ctx, { primary: { provider: openai(cfg, ep.fetchImpl), input: cfg }, context });
    // 前置：水位档是 none（67% 左右），按预算已是 tight
    const [capacity, tokens] = decide.mock.calls[0];
    expect(tokens / capacity).toBeGreaterThan(0.66);
    expect(tokens / capacity).toBeLessThan(0.70);
    expect(decide.mock.results[0].value).toBe('none');
    expect(events.filter(e => e.kind === 'pruned')).toEqual([{ kind: 'pruned', count: 2 }]);
    expect(summarize).not.toHaveBeenCalled();
    expect(ep.hits).toHaveLength(1);
    const outputs = toolOutputs(ep.hits[0].body);
    expect(outputs).toHaveLength(9);
    expect(outputs[0].startsWith('[工具结果已修剪')).toBe(true);
    expect(outputs[1].startsWith('[工具结果已修剪')).toBe(true);
    expect(outputs[8]).toBe(ascii(36_000));
    // 回调收到的是修剪之后、真正发出的那次请求的预算
    expect(budgets).toHaveLength(1);
    expect(budgets[0].status).toBe('ok');
    expect(budgets[0].input.tokens).toBeLessThan(12_000);
    expect(ep.hits[0].body.max_tokens).toBe(budgets[0].output.requested);
    expect(events.at(-1)).toEqual(TURN_END);
  });

  it('L23 修剪后仍然余量不足：再考虑压缩；压缩做不成（单回合）也不吞掉修剪，max_tokens 按修剪后的预算收紧', async () => {
    const ctx = mkCtx();
    ctx.say('run the nine steps');
    ctx.rounds('T', [8_000, 8_000, 60, 24_000, 24_000, 24_000, 24_000, 24_000, 24_000]);
    const cfg = relay(48_000);
    const ep = captureBody(() => openaiOk('ok'));
    const context = realContext(ctx);
    const summarize = vi.spyOn(context.engine, 'summarize');
    const decide = vi.spyOn(context.policy, 'decideWindow');
    const { events, budgets } = await run(ctx, { primary: { provider: openai(cfg, ep.fetchImpl), input: cfg }, context });
    expect(decide.mock.results[0].value).toBe('offload');
    expect(events.filter(e => e.kind === 'pruned')).toEqual([{ kind: 'pruned', count: 2 }]);
    // 修剪后仍是 tight、可压部分够大：问了一次压缩；单个用户回合、不足 30 条，summarize 不发请求、返回 undefined
    expect(summarize).toHaveBeenCalledTimes(1);
    await expect(summarize.mock.results[0].value).resolves.toBeUndefined();
    expect(ep.hits).toHaveLength(1);
    const outputs = toolOutputs(ep.hits[0].body);
    expect(outputs[0].startsWith('[工具结果已修剪')).toBe(true);
    expect(outputs[1].startsWith('[工具结果已修剪')).toBe(true);
    expect(budgets).toHaveLength(1);
    expect(budgets[0].status).toBe('tight');
    expect(ep.hits[0].body.max_tokens).toBe(budgets[0].output.requested);
    expect(ep.hits[0].body.max_tokens).toBeLessThan(8_192);
    expect(events.at(-1)).toEqual(TURN_END);
  });

  it('L24 压缩档上压缩失败（以及随后停用压缩的各轮）：余量不足时退到修剪', async () => {
    const ctx = mkCtx();
    ctx.say('task one');
    ctx.rounds('A', [16_000, 16_000, 16_000, 60, 60, 60]);
    ctx.say('task two');
    ctx.rounds('B', [60, 60, 60, 60, 60]);
    ctx.say('task three');
    ctx.rounds('C', [60, 60, 60, 60]);
    ctx.say('task four');
    ctx.rounds('D', [27_200, 27_200, 27_200, 27_200, 27_200]);
    expect(ctx.store.listMessages(ctx.sessionId)).toHaveLength(44);
    const cfg = relay(64_000, { maxOutputTokens: 16_000 });
    let main = 0;
    const ep = captureBody(body => {
      if (isSummaryRequest(body)) return new Response('{"error":{"message":"summary backend down"}}', { status: 500 });
      return main++ === 0 ? openaiToolCall('call_1') : openaiOk('done');
    });
    const context = realContext(ctx);
    const decide = vi.spyOn(context.policy, 'decideWindow');
    const { events } = await run(ctx, { primary: { provider: openai(cfg, ep.fetchImpl), input: cfg }, context });
    expect(decide.mock.results[0].value).toBe('compact');
    expect(events.filter(e => e.kind === 'compactFailed')).toHaveLength(1);
    expect(ep.hits.filter(h => isSummaryRequest(h.body))).toHaveLength(1);
    expect(events.filter(e => e.kind === 'pruned')).toEqual([{ kind: 'pruned', count: 3 }, { kind: 'pruned', count: 3 }]);
    const mains = ep.hits.filter(h => !isSummaryRequest(h.body));
    expect(mains).toHaveLength(2);
    for (const hit of mains) {
      const outputs = toolOutputs(hit.body);
      expect(outputs.slice(0, 3).every(o => o.startsWith('[工具结果已修剪'))).toBe(true);
      expect(outputs.at(-1)!.startsWith('[工具结果已修剪')).toBe(false);
    }
    expect(events.at(-1)).toEqual(TURN_END);
  });

  const prunedCounts = (events: LoopEvent[]): number[] => events.flatMap(e => e.kind === 'pruned' ? [e.count] : []);

  it('L27 窗口 32000 的单回合长工具任务、撑满窗口的是最近几条大结果：每轮都修剪，不为新增的两条消息发付费摘要，输入不逐轮上涨', async () => {
    const ctx = mkCtx({ tools: [bigEcho(14_000)] });
    ctx.say('run the long job');
    ctx.rounds('T', Array.from({ length: 15 }, () => 14_000));
    expect(ctx.store.listMessages(ctx.sessionId)).toHaveLength(31);
    const cfg = relay(32_000);
    let main = 0;
    // 按「输入 + max_tokens ≤ 窗口」校验的端点；模型再连调 9 轮工具后收尾
    const ep = captureBody(strictAll(32_000, body => {
      if (isSummaryRequest(body)) return openaiOk(SUMMARY_TEXT);
      return main++ < 9 ? openaiToolCall(`call_${main}`) : openaiOk('done');
    }));
    const { events, budgets } = await run(ctx, { primary: { provider: openai(cfg, ep.fetchImpl), input: cfg }, context: realContext(ctx) });
    expect(errorsOf(events)).toEqual([]);
    expect(events.at(-1)).toEqual(TURN_END);
    const mains = ep.hits.filter(h => !isSummaryRequest(h.body));
    expect(mains).toHaveLength(10);
    // 压缩能摘走的那段早已修剪成桩（不足 4,096 token）：一次付费的摘要请求都不发，压缩额度也没有被用掉
    expect(ep.hits.filter(h => isSummaryRequest(h.body))).toHaveLength(0);
    expect(events.some(e => e.kind === 'compacted' || e.kind === 'compactFailed')).toBe(false);
    // 每次正式请求之前都修剪过：请求体里只有最近 6 条结果是原文，更早的全是修剪桩
    expect(prunedCounts(events)).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
    mains.forEach((hit, i) => {
      const outputs = toolOutputs(hit.body);
      expect(outputs.filter(o => o === ascii(14_000)), `request ${i}`).toHaveLength(6);
      expect(outputs.filter(o => o.startsWith('[工具结果已修剪')), `request ${i}`).toHaveLength(9 + i);
    });
    // 输入估计不逐轮上涨（每轮只多一条工具调用与一条修剪桩），max_tokens 没有被压到下限
    expect(budgets).toHaveLength(10);
    expect(budgets.at(-1)!.input.tokens - budgets[0].input.tokens).toBeLessThan(1_500);
    for (const b of budgets) {
      expect(b.input.tokens).toBeLessThan(23_500);
      expect(b.output.requested).toBeGreaterThan(5_000);
    }
    mains.forEach((hit, i) => expect(hit.body.max_tokens, `request ${i}`).toBe(budgets[i].output.requested));
  });

  it('L28 已压缩满 3 次之后修剪照常：窗口 32000 的长工具任务不会因为用完压缩额度而停掉唯一的减压手段', async () => {
    // 每轮的工具调用带约 1,100 token 的入参（修剪动不了它，攒够四轮才值得摘一次），结果 10,000 字符
    const callArgs = JSON.stringify({ text: ascii(4_400), tool_title: 't' });
    const ctx = mkCtx({ tools: [bigEcho(10_000)] });
    ctx.say('run the long job');
    for (let i = 1; i <= 15; i++) {
      ctx.add('assistant', [{ type: 'toolUse', value: { toolUseId: `T${i}`, name: 'echo', input: callArgs } }]);
      ctx.add('user', [{ type: 'toolResult', value: { toolUseId: `T${i}`, output: ascii(10_000), success: true, status: 'success' } }]);
    }
    const cfg = relay(32_000);
    let main = 0;
    // 模型再连调 11 轮工具后收尾：第 1、5、9 次正式请求之前各压缩一次，之后还有 3 轮
    const ep = captureBody(strictAll(32_000, body => {
      if (isSummaryRequest(body)) return openaiOk(SUMMARY_TEXT);
      return main++ < 11 ? openaiToolCall(`call_${main}`, undefined, callArgs) : openaiOk('done');
    }));
    const { events, budgets } = await run(ctx, { primary: { provider: openai(cfg, ep.fetchImpl), input: cfg }, context: realContext(ctx) });
    expect(errorsOf(events)).toEqual([]);
    expect(events.at(-1)).toEqual(TURN_END);
    const kinds = kindsOf(events);
    expect(kinds.filter(k => k === 'compacted')).toHaveLength(3);
    expect(ep.hits.filter(h => isSummaryRequest(h.body))).toHaveLength(3);
    const mains = ep.hits.filter(h => !isSummaryRequest(h.body));
    expect(mains).toHaveLength(12);
    // 第 3 次压缩之后还有 4 次正式请求（压缩后的那一次，再加三轮工具）：每一次之前都修剪过
    expect(prunedCounts(events.slice(kinds.lastIndexOf('compacted') + 1))).toEqual([1, 2, 3, 4]);
    mains.slice(-4).forEach((hit, i) => {
      const outputs = toolOutputs(hit.body);
      expect(outputs.filter(o => o === ascii(10_000)), `request ${8 + i}`).toHaveLength(6);
      expect(outputs.filter(o => o.startsWith('[工具结果已修剪')), `request ${8 + i}`).toHaveLength(1 + i);
    });
    // 输入每轮只多一条工具调用与一条修剪桩（约 1,200），不是一条完整的结果（约 3,700）
    const tail = budgets.slice(-4).map(b => b.input.tokens);
    for (let i = 1; i < tail.length; i++) expect(tail[i] - tail[i - 1], `step ${i}`).toBeLessThan(1_600);
  });
});

describe('usage 落库、校准与并发', () => {
  /** 系统提示 12,000 字符：文本估计约 3,000，够校准的门槛。 */
  const SYS = ascii(12_000);

  it('L11 / L12 用真实 usage 校准：第一轮落估计值，第二轮起已校准；换一次运行（模拟重启）仍然已校准', async () => {
    const ctx = mkCtx();
    ctx.say('use the tool');
    const cfg = relay(128_000);
    const seen: RequestBudget[] = [];
    const ep = captureBody((_body, n) => {
      // 第一轮：端点报的输入是文本估计的 1.4 倍
      if (n === 0) return openaiToolCall('call_1', { prompt_tokens: Math.round(seen[0].input.raw.text * 1.4), completion_tokens: 9 });
      return openaiOk('done', { prompt_tokens: 5_000, completion_tokens: 3 });
    });
    const spec = { primary: { provider: openai(cfg, ep.fetchImpl), input: cfg }, systemPrompt: SYS, budgets: seen };
    const { events } = await run(ctx, spec);
    expect(events.at(-1)).toEqual(TURN_END);
    expect(seen).toHaveLength(2);
    expect(seen[0].input.raw.text).toBeGreaterThanOrEqual(2_000);
    expect(seen[0].input.calibration).toEqual({ ratio: 1, calibrated: false });
    const first = ctx.assistants()[0].tokenUsage!;
    expect(first.v).toBe(2);
    expect(first.estimate).toEqual({ text: seen[0].input.raw.text, media: 0, input: seen[0].input.tokens });
    expect(seen[1].input.calibration.calibrated).toBe(true);
    expect(seen[1].input.calibration.ratio).toBeCloseTo(1.4, 2);
    expect(seen[1].input.calibration.last).toEqual({ estimated: first.estimate!.input, actual: first.inputTokens, errorPct: Math.round((first.inputTokens - first.estimate!.input) / first.inputTokens * 100) });
    expect(seen[1].input.calibration.last!.errorPct).toBe(29);
    // 已校准：文本各项乘系数，余量按 5%
    expect(seen[1].input.tokens).toBeGreaterThan(seen[1].input.raw.text * 1.3);

    // L12：同一个库上新开一次运行（没有任何内存状态可继承）
    ctx.say('one more');
    const again = await run(ctx, { ...spec, budgets: [] });
    expect(again.events.at(-1)).toEqual(TURN_END);
    expect(again.budgets[0].input.calibration.calibrated).toBe(true);
    // 最近一条合格样本是第二轮那条：5000 ÷ 当时的文本估计
    const second = ctx.assistants()[1].tokenUsage!;
    expect(again.budgets[0].input.calibration.ratio).toBeCloseTo(5_000 / second.estimate!.text, 6);
  });

  it('L13 第一次尝试带着 usage 断流、重试成功：预算回调只调 1 次，落库的是成功那次的用量', async () => {
    const ctx = mkCtx();
    ctx.say('hi');
    const cfg = relay(128_000);
    const ep = captureBody((_body, n) => n === 0
      ? sse([{ choices: [{ index: 0, delta: { content: 'par' } }], usage: { prompt_tokens: 111, completion_tokens: 1 } }], false)
      : openaiOk('whole answer', { prompt_tokens: 222, completion_tokens: 5 }));
    const { events, budgets } = await run(ctx, { primary: { provider: openai(cfg, ep.fetchImpl), input: cfg } });
    expect(ep.hits).toHaveLength(2);
    expect(events.filter(e => e.kind === 'retry')).toHaveLength(1);
    expect(events.at(-1)).toEqual(TURN_END);
    expect(budgets).toHaveLength(1);
    expect(ctx.assistants()).toHaveLength(1);
    expect(ctx.assistants()[0].tokenUsage).toMatchObject({ inputTokens: 222, outputTokens: 5, v: 2 });
  });

  it('L14 取消时的半截回复：usage 带 v 与来源，不带估计与费用，不参与校准', async () => {
    const ctx = mkCtx();
    ctx.say('hi');
    const cfg = relay(128_000);
    const reached = gate();
    const stub: AgentProvider = {
      name: 'stub', modelId: cfg.modelId,
      async *streamAgentMessage(_req: StreamRequest, signal?: AbortSignal): AsyncIterable<AgentStreamEvent> {
        yield { kind: 'textDelta', text: 'half an ans' };
        yield { kind: 'usage', usage: { inputTokens: 3_000, outputTokens: 5 } };
        reached.open();
        await new Promise<never>((_, reject) => signal!.addEventListener('abort', () => reject(new ProviderError('aborted', { retryable: true }))));
      },
    };
    const controller = new AbortController();
    const running = run(ctx, { primary: { provider: stub, input: cfg }, systemPrompt: SYS, extra: { signal: controller.signal } });
    await reached.wait;
    controller.abort();
    const { events } = await running;
    expect(events.at(-1)).toEqual({ kind: 'error', message: '已取消' });
    const partial = ctx.assistants();
    expect(partial).toHaveLength(1);
    expect(partial[0].tokenUsage).toEqual({ inputTokens: 3_000, outputTokens: 5, v: 2, source: { by: 'provider', protocol: 'openai-chat', modelId: 'unlisted-model', instanceId: 'inst-relay' } });
    // 随后一次运行：那条半截消息没有估计值，不当校准样本（服务商报了输入，可计入实测上限）
    ctx.say('again');
    const ep = captureBody(() => openaiOk('ok'));
    const next = await run(ctx, { primary: { provider: openai(cfg, ep.fetchImpl), input: cfg }, systemPrompt: SYS });
    expect(next.budgets[0].input.calibration).toEqual({ ratio: 1, calibrated: false, observedMaxInput: 3_000 });
  });

  it('L18 没有 runtime 的旧调用方：不出预算、不调回调、max_tokens 是传入值；落库 usage 只多 v 与不带协议的来源', async () => {
    const ctx = mkCtx();
    ctx.say('hi');
    const cfg = relay(32_000);
    const ep = captureBody(() => openaiOk('cut', { prompt_tokens: 50_000, completion_tokens: 4_096 }, 'length'));
    const { events, budgets } = await run(ctx, { primary: { provider: openai(cfg, ep.fetchImpl) }, systemPrompt: ascii(200_000), extra: { maxTokens: 4_096 } });
    // 续写 2 次后以 maxTokens 收尾：turnEnd 不带 outputLimit
    expect(ep.hits).toHaveLength(3);
    for (const hit of ep.hits) expect(hit.body.max_tokens).toBe(4_096);
    expect(events.at(-1)).toEqual({ kind: 'turnEnd', stopReason: 'maxTokens' });
    expect(budgets).toEqual([]);
    expect(ctx.assistants()[0].tokenUsage).toEqual({ inputTokens: 50_000, outputTokens: 4_096, v: 2, source: { by: 'provider', modelId: 'unlisted-model' } });
  });

  it('L19 两个会话共用同一个 Provider 实例并发运行：各自落库的 usage 与回调对象互不串', async () => {
    const store = new ChatStore(openDb(':memory:'));
    const a = mkCtx({ store }); const b = mkCtx({ store });
    a.say('session A asks');
    b.say('session B asks');
    const cfg = relay(128_000);
    const gates = { A: gate(), B: gate() };
    const arrived = { A: gate(), B: gate() };
    const ep = captureBody(async body => {
      const who = JSON.stringify(body.messages).includes('session A') ? 'A' : 'B';
      arrived[who].open();
      await gates[who].wait;
      return who === 'A' ? openaiOk('to A', { prompt_tokens: 1_111, completion_tokens: 11 }) : openaiOk('to B', { prompt_tokens: 2_222, completion_tokens: 22 });
    });
    const provider = openai(cfg, ep.fetchImpl);
    const ra = run(a, { primary: { provider, input: cfg }, systemPrompt: ascii(4_000) });
    const rb = run(b, { primary: { provider, input: cfg }, systemPrompt: ascii(40_000) });
    // 两个请求都已发出并挂住；先放行 B，再放行 A
    await Promise.all([arrived.A.wait, arrived.B.wait]);
    gates.B.open();
    const doneB = await rb;
    gates.A.open();
    const doneA = await ra;
    expect(doneA.events.at(-1)).toEqual(TURN_END);
    expect(doneB.events.at(-1)).toEqual(TURN_END);
    expect(a.assistants()[0].tokenUsage).toMatchObject({ inputTokens: 1_111, outputTokens: 11 });
    expect(b.assistants()[0].tokenUsage).toMatchObject({ inputTokens: 2_222, outputTokens: 22 });
    expect(doneA.budgets).toHaveLength(1);
    expect(doneB.budgets).toHaveLength(1);
    expect(doneA.budgets[0].input.components.system).toBe(1_000);
    expect(doneB.budgets[0].input.components.system).toBe(10_000);
    expect(a.assistants()[0].tokenUsage!.estimate!.input).toBe(doneA.budgets[0].input.tokens);
    expect(b.assistants()[0].tokenUsage!.estimate!.input).toBe(doneB.budgets[0].input.tokens);
  });

  it('L20 预算计算抛错：回合照常完成，按模型上限发送，只警告一次，不调回调', async () => {
    const ctx = mkCtx();
    ctx.say('use the tool');
    const cfg = relay(32_000);
    const ep = captureBody((_body, n) => n === 0 ? openaiToolCall('call_1') : openaiOk('done'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fault.throwBudget = true;
    const { events, budgets } = await run(ctx, { primary: { provider: openai(cfg, ep.fetchImpl), input: cfg }, context: realContext(ctx) });
    expect(events.at(-1)).toEqual(TURN_END);
    expect(ep.hits).toHaveLength(2);
    for (const hit of ep.hits) expect(hit.body.max_tokens).toBe(8_192);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('请求预算计算失败');
    expect(budgets).toEqual([]);
  });
});

describe('验收 5：输出截断有可解释状态', () => {
  /** 手动窗口 32,000、手动最大输出 20,000、历史约 20,000 token：剩余空间约 8,900。 */
  function tightCtx(): { ctx: Ctx; cfg: RuntimeModelInput } {
    const ctx = mkCtx();
    ctx.say('write a long report');
    ctx.rounds('T', [80_000]);
    return { ctx, cfg: relay(32_000, { maxOutputTokens: 20_000 }) };
  }

  it('L15 被收紧的 max_tokens 截断正文：续写 2 次后 turnEnd 带上这次的 max_tokens、原因与续写次数', async () => {
    const { ctx, cfg } = tightCtx();
    const ep = captureBody(() => openaiOk('partial text ', undefined, 'length'));
    const { events, budgets } = await run(ctx, { primary: { provider: openai(cfg, ep.fetchImpl), input: cfg } });
    expect(ep.hits).toHaveLength(3);
    const last = events.at(-1) as Extract<LoopEvent, { kind: 'turnEnd' }>;
    expect(last.kind).toBe('turnEnd');
    expect(last.stopReason).toBe('maxTokens');
    expect(last.outputLimit).toEqual({ requested: ep.hits[2].body.max_tokens, limitedBy: 'window', continued: 2 });
    expect(last.outputLimit!.requested).toBeLessThan(20_000);
    expect(last.outputLimit!.requested).toBe(budgets[2].output.requested);
    // 正常收尾的回合不带这个字段
    const fine = mkCtx(); fine.say('hi');
    const ok = await run(fine, { primary: { provider: openai(cfg, captureBody(() => openaiOk('ok')).fetchImpl), input: cfg } });
    expect(ok.events.at(-1)).toEqual(TURN_END);
  });

  it('L26 被收紧的 max_tokens 截断了工具调用：落库之后、工具开始之前说明原因，固定句不含数字、只说一次', async () => {
    const { ctx, cfg } = tightCtx();
    const ep = captureBody((_body, n) => n < 2 ? openaiToolCall(`call_${n}`, undefined, '{"text":"unfin', 'length') : openaiOk('done'));
    const { events } = await run(ctx, { primary: { provider: openai(cfg, ep.fetchImpl), input: cfg } });
    expect(ep.hits).toHaveLength(3);
    const kinds = kindsOf(events);
    expect(kinds.slice(0, 3)).toEqual(['messagePersisted', 'capability', 'toolStart']);
    const notes = events.filter((e): e is Extract<LoopEvent, { kind: 'capability' }> => e.kind === 'capability' && e.cause === 'outputLimit');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toEqual({
      kind: 'capability', label: '主力', cause: 'outputLimit',
      notices: ['主力 这次输出被 max_tokens 截断：上下文剩余空间不足，max_tokens 已收紧，工具调用的参数可能不完整。可新建会话，或等下一轮压缩后重试'],
    });
    expect(notes[0].notices[0]).not.toMatch(/\d/);
    // 工具照常执行并回失败结果（参数被截成了空对象）
    const ends = events.filter((e): e is Extract<LoopEvent, { kind: 'toolEnd' }> => e.kind === 'toolEnd');
    expect(ends).toHaveLength(2);
    expect(ends.every(e => e.success === false)).toBe(true);
    expect(events.at(-1)).toEqual(TURN_END);
  });

  const outputLimitNotes = (events: LoopEvent[]) =>
    events.filter((e): e is Extract<LoopEvent, { kind: 'capability' }> => e.kind === 'capability' && e.cause === 'outputLimit');

  it('L30 默认额度（65,536）截断了工具调用：同样在工具开始之前说明，出路指向「手动修正 → 最大输出」；任务指定的额度造成的截断不发', async () => {
    const ctx = mkCtx();
    ctx.say('write the big file');
    const ep = captureBody((_body, n) => n < 2 ? openaiToolCall(`call_${n}`, undefined, '{"text":"unfin', 'length') : openaiOk('done'));
    const { events, budgets } = await run(ctx, { primary: { provider: openai(IND, ep.fetchImpl), input: IND } });
    expect(ep.hits).toHaveLength(3);
    // 前置：模型上限 128,000，这次按默认额度申请
    expect(ep.hits[0].body.max_tokens).toBe(65_536);
    expect(budgets[0].output).toMatchObject({ cap: 128_000, limitedBy: 'preference', preferenceSource: 'default' });
    const notes = outputLimitNotes(events);
    expect(notes).toEqual([{
      kind: 'capability', label: '主力', cause: 'outputLimit',
      notices: ['主力 这次输出被 max_tokens 截断：单次请求按默认额度申请输出，工具调用的参数可能不完整。需要更长的单次输出时，可在「设置 → 模型 → 编辑 → 手动修正」填写最大输出'],
    }]);
    expect(notes[0].notices[0]).not.toMatch(/\d/);
    // 落库之后、工具开始之前
    const at = events.indexOf(notes[0]);
    expect(at).toBeGreaterThan(events.findIndex(e => e.kind === 'messagePersisted'));
    expect(at).toBeLessThan(events.findIndex(e => e.kind === 'toolStart'));
    expect(events.at(-1)).toEqual(TURN_END);

    // 任务指定的额度是调用方自己要的，被它截断不属于默认额度：不发
    const t = mkCtx();
    t.say('write the big file');
    const ep2 = captureBody((_body, n) => n === 0 ? openaiToolCall('call_0', undefined, '{"text":"unfin', 'length') : openaiOk('done'));
    const task = await run(t, { primary: { provider: openai(IND, ep2.fetchImpl), input: IND }, extra: { outputPreference: 2_000 } });
    expect(ep2.hits[0].body.max_tokens).toBe(2_000);
    expect(task.budgets[0].output).toMatchObject({ limitedBy: 'preference', preferenceSource: 'task' });
    expect(outputLimitNotes(task.events)).toEqual([]);
    expect(task.events.at(-1)).toEqual(TURN_END);
  });

  /** 只有推理、没有正文与工具调用、以 length 收尾的回复（推理把输出额度用完了）。usage 传 null 表示服务商没报用量。 */
  const reasoningOnly = (usage: Record<string, unknown> | null = { prompt_tokens: 20_100, completion_tokens: 8_800, total_tokens: 28_900 }): Response => sse([
    { choices: [{ index: 0, delta: { reasoning_content: 'thinking it through ' } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'length' }] },
    ...(usage ? [{ choices: [], usage }] : []),
  ], true);

  it('L29 被收紧的 max_tokens 让推理吃光输出（正文为空、以 length 收尾）：报截断并说明原因，不当空响应降级，也不注入空响应提醒', async () => {
    // 单槽位：一条带 code 与截断说明的错误，不是「模型返回了空响应」
    const a = tightCtx();
    const ep = captureBody(() => reasoningOnly());
    const single = await run(a.ctx, { primary: { provider: openai(a.cfg, ep.fetchImpl), input: a.cfg } });
    expect(ep.hits).toHaveLength(1);
    expect(kindsOf(single.events)).toEqual(['thinkingDelta', 'error:outputLimit']);
    const requested = ep.hits[0].body.max_tokens as number;
    expect(requested).toBeLessThan(20_000);
    const err = errorsOf(single.events)[0];
    expect(err.outputLimit).toEqual({ requested, limitedBy: 'window', continued: 0 });
    // 这个槽位没有发推理参数（中转上未收录的型号，推理能力未确认）：出路里不提调低推理档位；服务商报的输出数照实附上
    expect('reasoning_effort' in ep.hits[0].body).toBe(false);
    expect(err.message).toBe(`主力 这次输出被 max_tokens 截断，没有产出正文：输出额度（max_tokens ${requested}）在正文之前就用完了，多为推理占用（服务商报告这次输出 8800，没有单列推理）。`
      + '上下文剩余空间不足，这次的 max_tokens 是收紧过的；可新建会话，或换用上下文窗口更大的模型');
    expect(err.message).not.toContain('空响应');
    expect('relayDraft' in err).toBe(false);
    // 只有思考的消息不进历史：assistant 消息仍只有事先落下的那一条工具调用
    expect(a.ctx.assistants()).toHaveLength(1);

    // 组里有备用：不按故障降级（没有 fallback 事件，也没有 turnEnd——index.ts 改绑要这两样），备用一次请求都没收到
    const b = tightCtx();
    const main = captureBody(() => reasoningOnly());
    const backupCfg = relay(1_000_000, { id: 'inst-big' });
    const backup = captureBody(() => openaiOk('from backup'));
    const grouped = await run(b.ctx, {
      primary: { provider: openai(b.cfg, main.fetchImpl), input: b.cfg },
      fallback: [{ provider: openai(backupCfg, backup.fetchImpl), input: backupCfg }],
    });
    expect(main.hits).toHaveLength(1);
    expect(backup.hits).toHaveLength(0);
    expect(kindsOf(grouped.events)).toEqual(['thinkingDelta', 'error:outputLimit']);

    // 工具结果之后收到同样的回复：不注入空响应提醒再试一次
    const c = tightCtx();
    const ep3 = captureBody((_body, n) => n === 0 ? openaiToolCall('call_1') : reasoningOnly());
    const afterTool = await run(c.ctx, { primary: { provider: openai(c.cfg, ep3.fetchImpl), input: c.cfg } });
    expect(ep3.hits).toHaveLength(2);
    expect(JSON.stringify(ep3.hits[1].body.messages)).not.toContain('系统提醒');
    expect(kindsOf(afterTool.events).at(-1)).toBe('error:outputLimit');
    expect(errorsOf(afterTool.events)[0].outputLimit).toMatchObject({ limitedBy: 'window', continued: 0 });
  });

  it('L29b 默认额度被推理用完同样报截断，出路指向最大输出；没有预算的旧调用方维持原来的空响应处理', async () => {
    const ctx = mkCtx();
    ctx.say('think hard');
    // 服务商报告输出 65,536、全是推理：额度确实是推理用完的
    const ep = captureBody(() => reasoningOnly({ prompt_tokens: 120, completion_tokens: 65_536, total_tokens: 65_656, completion_tokens_details: { reasoning_tokens: 65_536 } }));
    const { events } = await run(ctx, { primary: { provider: openai(IND, ep.fetchImpl), input: IND } });
    expect(kindsOf(events)).toEqual(['thinkingDelta', 'error:outputLimit']);
    const err = errorsOf(events)[0];
    expect(err.outputLimit).toEqual({ requested: 65_536, limitedBy: 'preference', continued: 0 });
    // 这次没有发推理参数（档位是关）：出路只有填大最大输出，不提调低推理档位
    expect('reasoning_effort' in ep.hits[0].body).toBe(false);
    expect(err.message).toBe('主力 这次输出被 max_tokens 截断，没有产出正文：输出额度（max_tokens 65536）在正文之前就用完了（服务商报告这次输出 65536，其中推理 65536）。'
      + '这次按默认额度申请输出；需要更长的单次输出时，在「设置 → 模型 → 编辑 → 手动修正」填写最大输出');
    expect(err.message).not.toContain('上下文剩余空间不足');

    // 旧调用方（没有 runtime）：没有预算，说不出 max_tokens 为什么是这个数，事件序列与以前相同
    const legacy = mkCtx();
    legacy.say('think hard');
    const cfg = relay(32_000);
    const ep2 = captureBody(() => reasoningOnly());
    const old = await run(legacy, { primary: { provider: openai(cfg, ep2.fetchImpl) }, extra: { maxTokens: 4_096 } });
    expect(old.events.at(-1)).toEqual({ kind: 'error', message: '模型返回了空响应' });
  });

  it('L31 输出额度在正文之前用完时，出路按这一轮实际发出的请求给：没发推理参数不提调低推理档位，兜底上限指向手动填写最大输出', async () => {
    const HEAD = '主力 这次输出被 max_tokens 截断，没有产出正文：';
    const FALLBACK_WAY = '这个输出上限是目录没有可用记录时的兜底值，确认模型的真实上限后可在「设置 → 模型 → 编辑 → 手动修正」填写最大输出，或换用模型';
    // 中转上目录未收录的型号、手动窗口 64,000：输出上限是兜底值 8,192；推理能力未确认，请求体里不带任何推理参数
    const cfg = relay(64_000);
    const once = async (extra: Partial<RunOptions>, reply: () => Response) => {
      const ctx = mkCtx();
      ctx.say('think hard');
      const ep = captureBody(reply);
      const { events, budgets } = await run(ctx, { primary: { provider: openai(cfg, ep.fetchImpl), input: cfg }, extra });
      expect(ep.hits).toHaveLength(1);
      expect(kindsOf(events).at(-1)).toBe('error:outputLimit');
      return { body: ep.hits[0].body, err: errorsOf(events)[0], budget: budgets[0] };
    };

    // 档位是关、服务商没报用量：模型自己把 8,192 用完了。照「调低推理档位」做，重发的请求与这一次逐字节相同
    const off = await once({}, () => reasoningOnly(null));
    expect(off.body.max_tokens).toBe(8_192);
    expect('reasoning_effort' in off.body).toBe(false);
    expect(off.budget.output).toMatchObject({ cap: 8_192, limitedBy: 'model' });
    expect(off.err.outputLimit).toEqual({ requested: 8_192, limitedBy: 'model', continued: 0 });
    expect(off.err.message).toBe(`${HEAD}输出额度（max_tokens 8192）在正文之前就用完了，多为推理占用。${FALLBACK_WAY}`);
    expect(off.err.message).not.toContain('推理档位');

    // 用户选了 high，但这个槽位的推理能力未确认、推理参数并没有发出去：同样不提调低推理档位
    const asked = await once({ thinkingLevel: 'high' }, () => reasoningOnly(null));
    expect('reasoning_effort' in asked.body).toBe(false);
    expect(asked.err.message).toBe(off.err.message);

    // 服务商报告只输出了 40（远低于 8,192）：不说额度用完了，也不让人去调大额度
    const low = await once({}, () => reasoningOnly({ prompt_tokens: 300, completion_tokens: 40, total_tokens: 340 }));
    expect(low.err.message).toBe(`${HEAD}服务商报告这次输出 40，没有单列推理，远低于这次的 max_tokens 8192：截断未必是这个额度造成的，端点自己的输出上限可能更小，或者它没有把推理计入输出。`
      + '可重试一次；仍然如此时换用模型，或在「设置 → 模型 → 编辑 → 手动修正」核对该接入的上下文窗口与最大输出');

    // 对照：推理参数真的发出去了（Anthropic 协议、推理手动标为支持、档位 high）——调低推理档位才是出路之一
    const claude: RuntimeModelInput = {
      id: 'inst-claude-relay', kind: 'anthropic', baseUrl: 'https://claude-relay.example', modelId: 'claude-relay-x',
      contextWindow: 200_000, maxOutputTokens: 30_000, capabilityOverrides: { reasoning: true },
    };
    const thinkingOnly = (): Response => anthropicSse([
      { type: 'message_start', message: { usage: { input_tokens: 100, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'weighing every option ' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-1' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 30_000, output_tokens_details: { thinking_tokens: 29_999 } } },
      { type: 'message_stop' },
    ]);
    const c = mkCtx();
    c.say('think hard');
    const ep = captureBody(thinkingOnly);
    const sent = await run(c, {
      primary: { provider: new AnthropicProvider({ apiKey: 'k', modelId: claude.modelId, baseUrl: claude.baseUrl, fetchImpl: ep.fetchImpl }), input: claude },
      extra: { thinkingLevel: 'high' },
    });
    expect(ep.hits).toHaveLength(1);
    expect(ep.hits[0].body.thinking).toMatchObject({ type: 'enabled' });
    expect(kindsOf(sent.events).filter(k => k !== 'capability')).toEqual(['thinkingDelta', 'error:outputLimit']);
    const err = errorsOf(sent.events)[0];
    expect(err.outputLimit).toEqual({ requested: 30_000, limitedBy: 'manual', continued: 0 });
    expect(err.message).toBe(`${HEAD}输出额度（max_tokens 30000）在正文之前就用完了（服务商报告这次输出 30000，其中推理 29999）。`
      + '可调低推理档位，或调高手动填写的最大输出后重发');
  });

  it('L32 输出上限是按本配置手动窗口的 3/4 封顶出来的（R2-1）：额度被用完时不说成模型自己的上限，出路是手动填写最大输出或调大手动窗口', async () => {
    const HEAD = '主力 这次输出被 max_tokens 截断，没有产出正文：';
    const WINDOW_WAY = '这个输出上限不是模型自己的上限，是按本配置手动填写的上下文窗口的 3/4 计的；'
      + '需要更长的单次输出时，可在「设置 → 模型 → 编辑 → 手动修正」填写最大输出，或在确认该接入的窗口更大后调大手动填写的上下文窗口';
    const once = async (cfg: RuntimeModelInput, extra: Partial<RunOptions> = {}) => {
      const ctx = mkCtx();
      ctx.say('think hard');
      const ep = captureBody(() => reasoningOnly(null));
      const { events, budgets } = await run(ctx, { primary: { provider: openai(cfg, ep.fetchImpl), input: cfg }, extra });
      expect(ep.hits).toHaveLength(1);
      expect(kindsOf(events).at(-1)).toBe('error:outputLimit');
      return { body: ep.hits[0].body, err: errorsOf(events)[0], budget: budgets[0] };
    };
    const sharedModel = (extra: Partial<RuntimeModelInput> = {}): RuntimeModelInput =>
      ({ id: 'inst-shared', kind: 'openai-compat', baseUrl: EXAMPLE_APIS.vendorA, modelId: 'shared-model', ...extra });

    // 收录端点上目录有记录的型号（记录：窗口 200,000 / 输出 32,000），本配置手动窗口 32,000、没填最大输出：端点记录被手动窗口挤掉，
    // 输出上限按手动窗口的 3/4（24,000）封顶。它不超过默认额度，max_tokens 就是它，limitedBy 为 model。档位是关，请求没带推理参数
    const off = await once(sharedModel({ contextWindow: 32_000 }));
    expect(off.body.max_tokens).toBe(24_000);
    expect('reasoning_effort' in off.body).toBe(false);
    expect(off.budget.output).toMatchObject({ cap: 24_000, limitedBy: 'model', preferenceSource: 'default' });
    expect(off.err.outputLimit).toEqual({ requested: 24_000, limitedBy: 'model', continued: 0 });
    expect(off.err.message).toBe(`${HEAD}输出额度（max_tokens 24000）在正文之前就用完了，多为推理占用。${WINDOW_WAY}`);
    expect(off.err.message).not.toContain('这已是该模型的输出上限');
    expect(off.err.message).not.toContain('换用输出上限更大的模型');
    expect(off.err.message).not.toContain('推理档位');

    // 同一个配置、档位 high：这个端点的记录声明了档位，reasoning_effort 真的发出去了——调低推理档位排在前面，后面仍是那两条
    const high = await once(sharedModel({ contextWindow: 32_000 }), { thinkingLevel: 'high' });
    expect(high.body.reasoning_effort).toBe('high');
    expect(high.body.max_tokens).toBe(24_000);
    expect(high.err.message).toBe(`${HEAD}输出额度（max_tokens 24000）在正文之前就用完了，多为推理占用。可调低推理档位后重发；${WINDOW_WAY}`);
    expect(high.err.message).not.toContain('换用输出上限更大的模型');

    // 中转（没有端点记录）加手动窗口 8,000：被挤掉的是佐证值 8,000，同样按 3/4（6,000）封顶，说法相同
    const relayed = await once({ id: 'inst-relay-shared', kind: 'openai-compat', baseUrl: RELAY, modelId: 'shared-model', contextWindow: 8_000 });
    expect(relayed.body.max_tokens).toBe(6_000);
    expect(relayed.budget.output).toMatchObject({ cap: 6_000, limitedBy: 'model' });
    expect(relayed.err.message).toBe(`${HEAD}输出额度（max_tokens 6000）在正文之前就用完了，多为推理占用。${WINDOW_WAY}`);

    // 对照：不填手动窗口，32,000 就是端点记录的原值——这才是模型自己的上限
    const plain = await once(sharedModel());
    expect(plain.body.max_tokens).toBe(32_000);
    expect(plain.budget.output).toMatchObject({ cap: 32_000, limitedBy: 'model' });
    expect(plain.err.message).toBe(`${HEAD}输出额度（max_tokens 32000）在正文之前就用完了，多为推理占用。这已是该模型的输出上限，可换用输出上限更大的模型`);
    // 对照：同时手动填了最大输出，max_tokens 是手动值，出路是调高它
    const manual = await once(sharedModel({ contextWindow: 32_000, maxOutputTokens: 20_000 }));
    expect(manual.err.outputLimit).toEqual({ requested: 20_000, limitedBy: 'manual', continued: 0 });
    expect(manual.err.message).toBe(`${HEAD}输出额度（max_tokens 20000）在正文之前就用完了，多为推理占用。可调高手动填写的最大输出后重发`);
  });

  it('L33 思考由服务端自适应的三个 Anthropic 型号（R2-2）：用户选了推理档位，档位也进不了请求体——额度被用完时不提调低推理档位', async () => {
    const HEAD = '主力 这次输出被 max_tokens 截断，没有产出正文：';
    /** 只有思考块、以 max_tokens 收尾的回复：自适应思考把这次的 max_tokens 用完了。 */
    const thinkingOnly = (output: number) => (): Response => anthropicSse([
      { type: 'message_start', message: { usage: { input_tokens: 100, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'weighing every option ' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-1' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: output, output_tokens_details: { thinking_tokens: output - 1 } } },
      { type: 'message_stop' },
    ]);
    const once = async (cfg: RuntimeModelInput, output: number) => {
      const ctx = mkCtx();
      ctx.say('think hard');
      const ep = captureBody(thinkingOnly(output));
      const provider = new AnthropicProvider({ apiKey: 'k', modelId: cfg.modelId, ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}), fetchImpl: ep.fetchImpl });
      const { events, budgets } = await run(ctx, { primary: { provider, input: cfg }, extra: { thinkingLevel: 'high' } });
      expect(ep.hits).toHaveLength(1);
      expect(kindsOf(events).at(-1)).toBe('error:outputLimit');
      return { body: ep.hits[0].body, err: errorsOf(events)[0], budget: budgets[0] };
    };

    // 中转上的三个型号，用户选了 high：构建器不看档位，请求体里没有 thinking、没有预算、没有档位——
    // 照「调低推理档位」做，重发的请求与这一次逐字节相同。出路只剩调高手动填写的最大输出
    for (const modelId of ['claude-fable-5-1', 'claude-mythos-5-1', 'claude-opus-5-5']) {
      const r = await once({
        id: `inst-${modelId}`, kind: 'anthropic', baseUrl: 'https://claude-relay.example', modelId,
        contextWindow: 200_000, maxOutputTokens: 30_000, capabilityOverrides: { reasoning: true },
      }, 30_000);
      expect('thinking' in r.body, modelId).toBe(false);
      expect(JSON.stringify(r.body), modelId).not.toMatch(/budget_tokens|effort/);
      expect(r.err.outputLimit, modelId).toEqual({ requested: 30_000, limitedBy: 'manual', continued: 0 });
      expect(r.err.message, modelId).toBe(`${HEAD}输出额度（max_tokens 30000）在正文之前就用完了（服务商报告这次输出 30000，其中推理 29999）。`
        + '可调高手动填写的最大输出后重发');
      expect(r.err.message, modelId).not.toContain('推理档位');
    }

    // 官方端点上的 claude-opus-5-5（目录记录：输出 128,000）：请求体写的是 adaptive，同样没有档位；这次按默认额度 65,536 申请
    const official = await once({ id: 'inst-opus-official', kind: 'anthropic', modelId: 'claude-opus-5-5' }, 65_536);
    expect(official.body.thinking).toEqual({ type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } });
    expect(JSON.stringify(official.body)).not.toMatch(/budget_tokens|effort/);
    expect(official.budget.output).toMatchObject({ cap: 128_000, requested: 65_536, limitedBy: 'preference', preferenceSource: 'default' });
    expect(official.err.message).toBe(`${HEAD}输出额度（max_tokens 65536）在正文之前就用完了（服务商报告这次输出 65536，其中推理 65535）。`
      + '这次按默认额度申请输出；需要更长的单次输出时，在「设置 → 模型 → 编辑 → 手动修正」填写最大输出');
    expect(official.err.message).not.toContain('推理档位');

    // 对照：同一个型号名经 OpenAI 兼容协议的中转接入（推理手动标为支持）——那边照常发 reasoning_effort，档位真的进了请求体，
    // 调低推理档位才是出路之一。例外只跟「Anthropic 协议上的这三个型号」走，不跟型号名走
    const viaOpenAI: RuntimeModelInput = {
      id: 'inst-opus-openai', kind: 'openai-compat', baseUrl: RELAY, modelId: 'claude-opus-5-5',
      contextWindow: 200_000, maxOutputTokens: 30_000, capabilityOverrides: { reasoning: true },
    };
    const c = mkCtx();
    c.say('think hard');
    const ep = captureBody(() => reasoningOnly({ prompt_tokens: 100, completion_tokens: 30_000, total_tokens: 30_100 }));
    const sent = await run(c, { primary: { provider: openai(viaOpenAI, ep.fetchImpl), input: viaOpenAI }, extra: { thinkingLevel: 'high' } });
    expect(ep.hits[0].body.reasoning_effort).toBe('high');
    expect(errorsOf(sent.events)[0].message).toBe(`${HEAD}输出额度（max_tokens 30000）在正文之前就用完了，多为推理占用（服务商报告这次输出 30000，没有单列推理）。`
      + '可调低推理档位，或调高手动填写的最大输出后重发');
  });

  // ── F02b：输出额度在正文之前用完，而这次的 max_tokens 是模型自己的输出上限或手动填的最大输出（limitedBy 为 model / manual）。
  // 这种截断与 F02 的收紧无关：F02 之前它按空响应在模型组内降到备用并得到回答。组里有接得住这一轮的后续槽位就换过去
  // （fallback 带 cause:'outputLimit'，不是故障），没有可换的才报 outputLimit 错误。window / floor / preference 照旧报错、不换。

  const BIG = relay(1_000_000, { id: 'inst-big' });
  /** 收录端点（vendor-a）上目录有记录的型号：窗口 200,000、输出 32,000。 */
  const vendorShared = (extra: Partial<RuntimeModelInput> = {}): RuntimeModelInput =>
    ({ id: 'inst-shared', kind: 'openai-compat', baseUrl: EXAMPLE_APIS.vendorA, modelId: 'shared-model', ...extra });
  const exhausted = (label: string, requested: number, way: string): string =>
    `${label} 这次输出被 max_tokens 截断，没有产出正文：输出额度（max_tokens ${requested}）在正文之前就用完了，多为推理占用。${way}`;
  const FALLBACK_CAP_WAY = '这个输出上限是目录没有可用记录时的兜底值，确认模型的真实上限后可在「设置 → 模型 → 编辑 → 手动修正」填写最大输出，或换用模型';
  const hopsOf = (events: LoopEvent[]) => events.filter((e): e is Extract<LoopEvent, { kind: 'fallback' }> => e.kind === 'fallback');
  /** 模型组 [主力, 备用1, …]：主力只回推理、以 length 收尾（服务商没报用量）；各备用按给定的应答。抓每个槽位各自收到的请求。 */
  async function grouped(
    ctx: Ctx, mainCfg: RuntimeModelInput, backups: { cfg: RuntimeModelInput; reply: (body: Body, n: number) => Response }[],
    more: { extra?: Partial<RunOptions>; systemPrompt?: string; context?: RunSpec['context']; mainReply?: (body: Body, n: number) => Response } = {},
  ) {
    const main = captureBody(more.mainReply ?? (() => reasoningOnly(null)));
    const eps = backups.map(b => captureBody(b.reply));
    const r = await run(ctx, {
      primary: { provider: openai(mainCfg, main.fetchImpl), input: mainCfg },
      fallback: backups.map((b, i) => ({ provider: openai(b.cfg, eps[i].fetchImpl), input: b.cfg })),
      ...(more.extra ? { extra: more.extra } : {}),
      ...(more.systemPrompt !== undefined ? { systemPrompt: more.systemPrompt } : {}),
      ...(more.context ? { context: more.context } : {}),
    });
    return { ...r, main, backups: eps };
  }

  it('L34 输出额度在正文之前用完、max_tokens 是模型自己的输出上限（limitedBy 为 model）：组里有备用就换过去（fallback cause:outputLimit），备用收到这一轮的请求并正常收尾', async () => {
    const cases: { name: string; cfg: RuntimeModelInput; requested: number; way: string }[] = [
      // 目录没有记录时的兜底值（中转上未收录的型号）
      { name: '兜底值', cfg: relay(64_000), requested: 8_192, way: FALLBACK_CAP_WAY },
      // 端点记录原样采用的上限
      { name: '端点记录', cfg: vendorShared(), requested: 32_000, way: '这已是该模型的输出上限，可换用输出上限更大的模型' },
      // 按本配置手动窗口的 3/4 封顶出来的上限
      {
        name: '手动窗口封顶', cfg: vendorShared({ contextWindow: 32_000 }), requested: 24_000,
        way: '这个输出上限不是模型自己的上限，是按本配置手动填写的上下文窗口的 3/4 计的；'
          + '需要更长的单次输出时，可在「设置 → 模型 → 编辑 → 手动修正」填写最大输出，或在确认该接入的窗口更大后调大手动填写的上下文窗口',
      },
    ];
    for (const k of cases) {
      const ctx = mkCtx();
      ctx.say('think hard');
      const g = await grouped(ctx, k.cfg, [{ cfg: BIG, reply: () => openaiOk('from backup', { prompt_tokens: 50, completion_tokens: 4, total_tokens: 54 }) }]);
      // 请求序列：主力 1 次（按它自己的上限申请）、备用 1 次
      expect(g.main.hits, k.name).toHaveLength(1);
      expect(g.backups[0].hits, k.name).toHaveLength(1);
      expect(g.main.hits[0].body.max_tokens, k.name).toBe(k.requested);
      expect(g.budgets.map(b => [b.slot.label, b.output.limitedBy]), k.name).toEqual([['主力', 'model'], ['备用1', 'model']]);
      // 事件：一条带 cause 的 fallback，reason 就是 outputLimit 错误会写的那句说明；没有 error，回合正常收尾（turnEnd 不带 outputLimit）
      expect(kindsOf(g.events), k.name).toEqual(['thinkingDelta', 'fallback:outputLimit', 'textDelta', 'messagePersisted', 'turnEnd']);
      expect(g.events[1], k.name).toEqual({ kind: 'fallback', from: '主力', to: '备用1', cause: 'outputLimit', reason: exhausted('主力', k.requested, k.way) });
      expect((g.events[1] as { reason: string }).reason, k.name).not.toContain('空响应');
      expect(g.events.at(-1), k.name).toEqual(TURN_END);
      // 备用收到的就是这一轮的请求：末条是用户的提问，max_tokens 按备用自己的预算，没有空响应提醒，也没有主力的半截推理
      const body = g.backups[0].hits[0].body;
      expect(body.max_tokens, k.name).toBe(g.budgets[1].output.requested);
      expect(body.messages.at(-1), k.name).toEqual({ role: 'user', content: 'think hard' });
      expect(JSON.stringify(body.messages), k.name).not.toContain('系统提醒');
      expect(JSON.stringify(body.messages), k.name).not.toContain('thinking it through');
      // 落库：主力那次什么都不落（只有思考的消息不进历史），备用的回复照常落、用量记在备用头上
      const stored = ctx.assistants();
      expect(stored, k.name).toHaveLength(1);
      expect(stored[0].parts, k.name).toEqual([{ type: 'text', value: 'from backup' }]);
      expect(stored[0].tokenUsage, k.name).toMatchObject({ inputTokens: 50, outputTokens: 4, v: 2, source: { instanceId: 'inst-big' } });
    }
  });

  it('L34b 同上，max_tokens 是手动填的最大输出（limitedBy 为 manual）：同样换到备用', async () => {
    const ctx = mkCtx();
    ctx.say('think hard');
    const g = await grouped(ctx, vendorShared({ contextWindow: 32_000, maxOutputTokens: 20_000 }), [{ cfg: BIG, reply: () => openaiOk('from backup') }]);
    expect(g.main.hits).toHaveLength(1);
    expect(g.backups[0].hits).toHaveLength(1);
    expect(g.main.hits[0].body.max_tokens).toBe(20_000);
    expect(g.budgets[0].output).toMatchObject({ requested: 20_000, limitedBy: 'manual', preferenceSource: 'manual' });
    expect(kindsOf(g.events)).toEqual(['thinkingDelta', 'fallback:outputLimit', 'textDelta', 'messagePersisted', 'turnEnd']);
    expect(g.events[1]).toEqual({ kind: 'fallback', from: '主力', to: '备用1', cause: 'outputLimit', reason: exhausted('主力', 20_000, '可调高手动填写的最大输出后重发') });
    expect(g.events.at(-1)).toEqual(TURN_END);
    expect(g.backups[0].hits[0].body.messages.at(-1)).toEqual({ role: 'user', content: 'think hard' });
    expect(ctx.assistants().map(m => m.parts)).toEqual([[{ type: 'text', value: 'from backup' }]]);
  });

  it('L34c 按输出额度换槽不消耗回合额度：回合上限为 1 时，换到备用后这一轮照常发出并收尾，不报「已达最大回合数」', async () => {
    // 被换下的那次请求没有产出任何回答，不算一轮；少了这一条，回合上限恰好用完的运行会在换槽后直接以「已达最大回合数」收尾，
    // 那个出口不带截断说明（它假定走到这里时已经有槽位给出过回答）
    const ctx = mkCtx();
    ctx.say('think hard');
    const g = await grouped(ctx, relay(64_000), [{ cfg: BIG, reply: () => openaiOk('from backup') }], { extra: { maxTurns: 1 } });
    expect(g.main.hits).toHaveLength(1);
    expect(g.backups[0].hits).toHaveLength(1);
    expect(kindsOf(g.events)).toEqual(['thinkingDelta', 'fallback:outputLimit', 'textDelta', 'messagePersisted', 'turnEnd']);
    expect(g.events.at(-1)).toEqual(TURN_END);
    expect(errorsOf(g.events)).toEqual([]);
    expect(ctx.assistants().map(m => m.parts)).toEqual([[{ type: 'text', value: 'from backup' }]]);
  });

  it('L35 对照：max_tokens 是被剩余空间收紧的（window / floor）或按额度申请的（默认额度、任务指定）——仍报 outputLimit 错误，组里的备用一次请求都不收', async () => {
    const check = async (name: string, ctx: Ctx, cfg: RuntimeModelInput, limitedBy: string, extra: Partial<RunOptions> = {}) => {
      const before = ctx.assistants().length;
      const g = await grouped(ctx, cfg, [{ cfg: BIG, reply: () => openaiOk('never') }], { extra });
      expect(g.main.hits, name).toHaveLength(1);
      expect(g.backups[0].hits, name).toHaveLength(0);
      expect(kindsOf(g.events), name).toEqual(['thinkingDelta', 'error:outputLimit']);
      expect(errorsOf(g.events)[0].outputLimit, name).toEqual({ requested: g.main.hits[0].body.max_tokens, limitedBy, continued: 0 });
      expect(g.budgets.map(b => b.slot.label), name).toEqual(['主力']);
      expect(ctx.assistants(), name).toHaveLength(before);
      return g;
    };
    // window：手动窗口 32,000、手动最大输出 20,000、历史约 20,000——max_tokens 收紧到剩余空间
    const w = tightCtx();
    const win = await check('window', w.ctx, w.cfg, 'window');
    expect(win.main.hits[0].body.max_tokens).toBeLessThan(20_000);
    expect(win.main.hits[0].body.max_tokens).toBeGreaterThan(1_024);
    // floor：历史约 30,000，手动窗口 32,000 已经放不下——max_tokens 落到下限
    const f = mkCtx();
    f.say('write a long report');
    f.rounds('T', [120_000]);
    const floor = await check('floor', f, relay(32_000), 'floor');
    expect(floor.main.hits[0].body.max_tokens).toBe(1_024);
    // 默认额度：模型上限 128,000，这次按 65,536 申请
    const d = mkCtx();
    d.say('think hard');
    const dflt = await check('默认额度', d, IND, 'preference');
    expect(dflt.main.hits[0].body.max_tokens).toBe(65_536);
    expect(dflt.budgets[0].output.preferenceSource).toBe('default');
    // 任务指定的额度
    const t = mkCtx();
    t.say('think hard');
    const task = await check('任务指定', t, IND, 'preference', { outputPreference: 2_000 });
    expect(task.main.hits[0].body.max_tokens).toBe(2_000);
    expect(task.budgets[0].output.preferenceSource).toBe('task');
  });

  it('L36 没有可换的槽位（单模型，或组里的备用接不了这一轮）：仍以 outputLimit 错误收尾，说明文字与换槽之前逐字相同', async () => {
    // 单模型、上限是兜底值（limitedBy 为 model）
    const a = mkCtx();
    a.say('think hard');
    const cfg = relay(64_000);
    const ep = captureBody(() => reasoningOnly(null));
    const single = await run(a, { primary: { provider: openai(cfg, ep.fetchImpl), input: cfg } });
    expect(ep.hits).toHaveLength(1);
    expect(kindsOf(single.events)).toEqual(['thinkingDelta', 'error:outputLimit']);
    expect(errorsOf(single.events)[0]).toEqual({
      kind: 'error', code: 'outputLimit', outputLimit: { requested: 8_192, limitedBy: 'model', continued: 0 },
      message: exhausted('主力', 8_192, FALLBACK_CAP_WAY),
    });
    expect(a.assistants()).toEqual([]);

    // 单模型、手动填的最大输出（limitedBy 为 manual）
    const m = mkCtx();
    m.say('think hard');
    const manualCfg = vendorShared({ contextWindow: 32_000, maxOutputTokens: 20_000 });
    const ep2 = captureBody(() => reasoningOnly(null));
    const manual = await run(m, { primary: { provider: openai(manualCfg, ep2.fetchImpl), input: manualCfg } });
    expect(ep2.hits).toHaveLength(1);
    expect(kindsOf(manual.events)).toEqual(['thinkingDelta', 'error:outputLimit']);
    expect(errorsOf(manual.events)[0]).toEqual({
      kind: 'error', code: 'outputLimit', outputLimit: { requested: 20_000, limitedBy: 'manual', continued: 0 },
      message: exhausted('主力', 20_000, '可调高手动填写的最大输出后重发'),
    });

    // 组里唯一的备用放不下这次请求的固定部分（系统提示约 50,000，它的手动窗口只有 32,000）：说明跳过了谁，备用 0 请求，
    // 报的仍是主力的那句说明
    const b = mkCtx();
    b.say('think hard');
    const g = await grouped(b, BIG, [{ cfg: relay(32_000), reply: () => openaiOk('never') }], { systemPrompt: ascii(200_000) });
    expect(g.main.hits).toHaveLength(1);
    expect(g.backups[0].hits).toHaveLength(0);
    expect(kindsOf(g.events)).toEqual(['thinkingDelta', 'capability', 'error:outputLimit']);
    const skipped = g.events[1] as Extract<LoopEvent, { kind: 'capability' }>;
    expect(skipped.label).toBe('备用1');
    expect(skipped.notices).toHaveLength(1);
    expect(skipped.notices[0]).toMatch(/^已跳过：备用1 放不下这次请求的固定部分/);
    expect(errorsOf(g.events)[0]).toEqual({
      kind: 'error', code: 'outputLimit', outputLimit: { requested: 8_192, limitedBy: 'model', continued: 0 },
      message: exhausted('主力', 8_192, FALLBACK_CAP_WAY),
    });
    expect(b.assistants()).toEqual([]);
  });

  it('L37 换到备用后备用也把输出用完：按备用自己的 limitedBy 再判一次；链用尽时报错收尾，不死循环', async () => {
    // [主力(model), 备用1(model)]：两个都只回推理。各请求 1 次。会话没有改绑、下一条消息仍先给主力：终态报的是最先被换下的
    // 主力的截断说明，备用1 自己的那句作为最后的失败原因附在后面（与换过去的成员故障、空响应时同一个口径）
    const a = mkCtx();
    a.say('think hard');
    const ga = await grouped(a, relay(64_000), [{ cfg: BIG, reply: () => reasoningOnly(null) }]);
    expect(ga.main.hits).toHaveLength(1);
    expect(ga.backups[0].hits).toHaveLength(1);
    expect(kindsOf(ga.events)).toEqual(['thinkingDelta', 'fallback:outputLimit', 'thinkingDelta', 'error:outputLimit']);
    expect(errorsOf(ga.events)[0]).toEqual({
      kind: 'error', code: 'outputLimit', outputLimit: { requested: 8_192, limitedBy: 'model', continued: 0 },
      message: `${exhausted('主力', 8_192, FALLBACK_CAP_WAY)}${afterSwitch(exhausted('备用1', 8_192, FALLBACK_CAP_WAY))}`,
    });
    expect(a.assistants()).toEqual([]);

    // [主力(model), 备用1(manual), 备用2 正常]：连换两次，都不是故障；备用2 收尾
    const b = mkCtx();
    b.say('think hard');
    const gb = await grouped(b, relay(64_000), [
      { cfg: vendorShared({ contextWindow: 32_000, maxOutputTokens: 20_000 }), reply: () => reasoningOnly(null) },
      { cfg: BIG, reply: () => openaiOk('from backup 2') },
    ]);
    expect([gb.main.hits.length, gb.backups[0].hits.length, gb.backups[1].hits.length]).toEqual([1, 1, 1]);
    expect(kindsOf(gb.events)).toEqual(['thinkingDelta', 'fallback:outputLimit', 'thinkingDelta', 'fallback:outputLimit', 'textDelta', 'messagePersisted', 'turnEnd']);
    expect(hopsOf(gb.events)).toEqual([
      { kind: 'fallback', from: '主力', to: '备用1', cause: 'outputLimit', reason: exhausted('主力', 8_192, FALLBACK_CAP_WAY) },
      { kind: 'fallback', from: '备用1', to: '备用2', cause: 'outputLimit', reason: exhausted('备用1', 20_000, '可调高手动填写的最大输出后重发') },
    ]);
    expect(gb.budgets.map(x => [x.slot.label, x.output.limitedBy])).toEqual([['主力', 'model'], ['备用1', 'manual'], ['备用2', 'model']]);
    expect(gb.events.at(-1)).toEqual(TURN_END);
    expect(b.assistants().map(x => x.parts)).toEqual([[{ type: 'text', value: 'from backup 2' }]]);

    // [主力(model), 备用1(window), 备用2]：备用1 的 max_tokens 是被它自己的剩余空间收紧的——那是收紧造成的截断，不再往后换。
    // 终态同上：带的是主力的 outputLimit，备用1 那句（收紧过的 max_tokens 与它的出路）附在后面
    const c = tightCtx();
    const gc = await grouped(c.ctx, BIG, [
      { cfg: { ...c.cfg, id: 'inst-tight' }, reply: () => reasoningOnly(null) },
      { cfg: relay(1_000_000, { id: 'inst-big-2' }), reply: () => openaiOk('never') },
    ]);
    expect([gc.main.hits.length, gc.backups[0].hits.length, gc.backups[1].hits.length]).toEqual([1, 1, 0]);
    expect(kindsOf(gc.events)).toEqual(['thinkingDelta', 'fallback:outputLimit', 'thinkingDelta', 'error:outputLimit']);
    expect(gc.budgets.map(x => [x.slot.label, x.output.limitedBy])).toEqual([['主力', 'model'], ['备用1', 'window']]);
    const err = errorsOf(gc.events)[0];
    expect(err.outputLimit).toEqual({ requested: 8_192, limitedBy: 'model', continued: 0 });
    expect(err.message.startsWith(`${exhausted('主力', 8_192, FALLBACK_CAP_WAY)}。随后换用的备用模型也没有给出回答（最后的错误：备用1 这次输出被 max_tokens 截断，没有产出正文：`)).toBe(true);
    expect(err.message).toContain(`输出额度（max_tokens ${gc.backups[0].hits[0].body.max_tokens}）在正文之前就用完了`);
    expect(gc.backups[0].hits[0].body.max_tokens).toBeLessThan(20_000);
    expect(err.message).toContain('备用1 这次输出被 max_tokens 截断，没有产出正文');
    expect(err.message).toContain('上下文剩余空间不足，这次的 max_tokens 是收紧过的');
  });

  it('L38 工具结果之后、续写途中遇到这种回复：换到备用时不重跑工具、不注入空响应提醒，已落库的内容原样', async () => {
    // 工具结果之后：主力第一轮调了工具，第二轮只回推理、以 length 收尾
    let executed = 0;
    const counting: ToolExecutor = {
      definition: echoTool.definition,
      async execute(input) { executed++; return { output: `echo:${String(input.text)}`, success: true }; },
    };
    const ctx = mkCtx({ tools: [counting] });
    ctx.say('use the tool');
    const cfg = relay(64_000);
    const main = captureBody((_body, n) => n === 0 ? openaiToolCall('call_1') : reasoningOnly(null));
    const backup = captureBody(() => openaiOk('from backup'));
    const { events } = await run(ctx, {
      primary: { provider: openai(cfg, main.fetchImpl), input: cfg },
      fallback: [{ provider: openai(BIG, backup.fetchImpl), input: BIG }],
    });
    expect(main.hits).toHaveLength(2);
    expect(backup.hits).toHaveLength(1);
    // 工具只执行过一次：换槽重发的是同一轮的请求，不是从头再来
    expect(executed).toBe(1);
    expect(events.filter(e => e.kind === 'toolStart')).toHaveLength(1);
    expect(hopsOf(events)).toEqual([{ kind: 'fallback', from: '主力', to: '备用1', cause: 'outputLimit', reason: exhausted('主力', 8_192, FALLBACK_CAP_WAY) }]);
    expect(events.findIndex(e => e.kind === 'fallback')).toBeGreaterThan(events.findIndex(e => e.kind === 'toolEnd'));
    expect(events.some(e => e.kind === 'error')).toBe(false);
    expect(events.at(-1)).toEqual(TURN_END);
    // 备用收到的请求带着那条工具结果，没有空响应提醒
    expect(toolOutputs(backup.hits[0].body)).toEqual(['echo:x']);
    expect(JSON.stringify(backup.hits[0].body.messages)).not.toContain('系统提醒');
    // 落库：用户消息、工具调用、工具结果、备用的回复——主力那次只有推理的回复不落
    const stored = ctx.store.listMessages(ctx.sessionId);
    expect(stored.map(x => x.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(stored[1].parts).toEqual([{ type: 'toolUse', value: { toolUseId: 'call_1', name: 'echo', input: '{"text":"x","tool_title":"t"}' } }]);
    expect(stored[2].parts).toEqual([{ type: 'toolResult', value: { toolUseId: 'call_1', output: 'echo:x', success: true, status: 'success' } }]);
    expect(stored[3].parts).toEqual([{ type: 'text', value: 'from backup' }]);

    // 续写途中：主力第一段正文被截断（照常落库、续写），续写那次只回推理——备用接着续写，请求里带着续写提示
    const c = mkCtx();
    c.say('write a long report');
    const main2 = captureBody((_body, n) => n === 0 ? openaiOk('partial text ', undefined, 'length') : reasoningOnly(null));
    const backup2 = captureBody(() => openaiOk('the rest'));
    const cont = await run(c, {
      primary: { provider: openai(cfg, main2.fetchImpl), input: cfg },
      fallback: [{ provider: openai(BIG, backup2.fetchImpl), input: BIG }],
    });
    expect(main2.hits).toHaveLength(2);
    expect(backup2.hits).toHaveLength(1);
    expect(hopsOf(cont.events).map(e => [e.from, e.to, e.cause])).toEqual([['主力', '备用1', 'outputLimit']]);
    expect(JSON.stringify(backup2.hits[0].body.messages)).toContain('上一条输出因长度上限被截断');
    expect(cont.events.at(-1)).toEqual(TURN_END);
    expect(c.assistants().map(x => x.parts)).toEqual([[{ type: 'text', value: 'partial text ' }], [{ type: 'text', value: 'the rest' }]]);
  });

  const rateLimited = (): Response => new Response(JSON.stringify({ error: { message: 'rate limited (mock)' } }), { status: 429 });
  /** 按输出额度换槽之后链上的备用都没接住时，终态错误在被换下槽位的截断说明后面附的那一段。 */
  const afterSwitch = (detail: string): string => `。随后换用的备用模型也没有给出回答（最后的错误：${detail}）`;
  /** 单槽位跑一次必然失败的请求，取 Provider 报的原始错误文本（链上没有别的槽位时循环原样报出）。 */
  async function rawErrorOf(reply: () => Response): Promise<string> {
    const ctx = mkCtx();
    ctx.say('think hard');
    const { events } = await run(ctx, { primary: { provider: openai(BIG, captureBody(reply).fetchImpl), input: BIG } });
    const err = errorsOf(events)[0];
    expect(err.code).toBeUndefined();
    return err.message;
  }

  it('L39 与故障降级出现在同一轮：按输出额度换槽不算「降级过」——接手的槽位随后故障且链已用尽时，报的是被换下槽位的截断说明并附上接手槽位自己的错误；故障降级之后接手的槽位把输出用完，照样往后换', async () => {
    // [主力(model，输出用完), 备用1(限流)]：主力没有坏，不说「所有模型均不可用」；出路在主力身上，终态错误仍是它的截断说明
    const a = mkCtx();
    a.say('think hard');
    const ga = await grouped(a, relay(64_000), [{ cfg: BIG, reply: rateLimited }]);
    expect([ga.main.hits.length, ga.backups[0].hits.length]).toEqual([1, 1]);
    expect(kindsOf(ga.events).slice(0, 2)).toEqual(['thinkingDelta', 'fallback:outputLimit']);
    expect(ga.events).toHaveLength(3);
    const last = ga.events.at(-1) as Extract<LoopEvent, { kind: 'error' }>;
    expect(last.kind).toBe('error');
    expect(last.code).toBe('outputLimit');
    expect(last.outputLimit).toEqual({ requested: 8_192, limitedBy: 'model', continued: 0 });
    expect(last.message).toBe(`${exhausted('主力', 8_192, FALLBACK_CAP_WAY)}${afterSwitch(await rawErrorOf(rateLimited))}`);
    expect(last.message).toContain('rate limited (mock)');
    expect(last.message).not.toContain('所有模型均不可用');
    expect(a.assistants()).toEqual([]);

    // [主力(限流), 备用1(model，输出用完), 备用2 正常]：先是故障降级，再按输出额度换一次
    const b = mkCtx();
    b.say('think hard');
    const cfg = relay(64_000);
    const main = captureBody(rateLimited);
    const first = captureBody(() => reasoningOnly(null));
    const second = captureBody(() => openaiOk('from backup 2'));
    const second2 = relay(1_000_000, { id: 'inst-big-2' });
    const { events } = await run(b, {
      primary: { provider: openai(cfg, main.fetchImpl), input: cfg },
      fallback: [{ provider: openai(BIG, first.fetchImpl), input: BIG }, { provider: openai(second2, second.fetchImpl), input: second2 }],
    });
    expect([main.hits.length, first.hits.length, second.hits.length]).toEqual([1, 1, 1]);
    expect(kindsOf(events)).toEqual(['fallback:failure', 'thinkingDelta', 'fallback:outputLimit', 'textDelta', 'messagePersisted', 'turnEnd']);
    expect(hopsOf(events).map(e => [e.from, e.to])).toEqual([['主力', '备用1'], ['备用1', '备用2']]);
    expect(events.at(-1)).toEqual(TURN_END);
    expect(b.assistants().map(x => x.parts)).toEqual([[{ type: 'text', value: 'from backup 2' }]]);
  });

  // ── 评审 B2：按输出额度换槽不为接手的槽位压缩对话。会话没有改绑，压缩记录却对会话里所有模型生效——
  // 主力的窗口还空着，早先的对话就被摘要永久替换了。要先压缩才放得下的槽位说明后跳过；修剪只动请求、不落库，照常。

  /** pairs 组长问答加一句提问：用户回合不止 3 个，摘要有东西可摘。每条消息 chars 个字符（÷4 即 token 数）。 */
  const longChat = (pairs: number, chars = 11_700, tools?: ToolExecutor[]): Ctx => {
    const ctx = mkCtx(tools ? { tools } : {});
    for (let i = 1; i <= pairs; i++) {
      ctx.say(`question ${i}: ${ascii(chars)}`);
      ctx.add('assistant', [{ type: 'text', value: `answer ${i}: ${ascii(chars)}` }]);
    }
    ctx.say('keep going');
    return ctx;
  };
  const skippedForCompact = (label: string): string => `已跳过：${label} 要先压缩这段对话才放得下这一轮；这次换用不是因为故障，不为它压缩对话`;
  const backupReply = (body: Body): Response => isSummaryRequest(body) ? openaiOk(SUMMARY_TEXT) : openaiOk('from backup');
  /** 水位判断里针对某个窗口的那几次（档位与当时的输入）。 */
  const tiersFor = (decide: { mock: { calls: unknown[][]; results: { value: unknown }[] } }, capacity: number) =>
    decide.mock.calls.map((c, i) => ({ capacity: c[0] as number, tokens: c[1] as number, tier: decide.mock.results[i].value as string })).filter(x => x.capacity === capacity);

  it('L40 接手的槽位要先压缩对话才放得下这一轮：按输出额度换槽不为它发摘要请求、不写压缩记录——说明后跳过，往后找不用压缩的；链上再没有就照旧报截断', async () => {
    const SMALL = relay(64_000, { id: 'inst-small' });
    const mainError = {
      kind: 'error', code: 'outputLimit', outputLimit: { requested: 8_192, limitedBy: 'model', continued: 0 },
      message: exhausted('主力', 8_192, FALLBACK_CAP_WAY),
    };

    // [主力 窗口 1,000,000, 备用1 窗口 64,000]：8 组长问答约 47,000 token，对主力不到 5%，对备用1 在压缩档（73% 左右）
    const a = longChat(8);
    const ca = realContext(a);
    const summarizeA = vi.spyOn(ca.engine, 'summarize');
    const decideA = vi.spyOn(ca.policy, 'decideWindow');
    const ga = await grouped(a, BIG, [{ cfg: SMALL, reply: backupReply }], { context: ca });
    // 前置：按备用1 的窗口第一次判水位就是压缩档；主力只判过一次、不到档
    expect(tiersFor(decideA, 64_000)[0]).toMatchObject({ tier: 'compact' });
    expect(tiersFor(decideA, 1_000_000).map(x => x.tier)).toEqual(['none']);
    // 备用1 一个请求都没收到（摘要请求也没有），压缩记录没有写；报的仍是主力的那句说明
    expect(ga.main.hits).toHaveLength(1);
    expect(ga.backups[0].hits).toHaveLength(0);
    expect(summarizeA).not.toHaveBeenCalled();
    expect(a.store.getLatestCompactMarker(a.sessionId)).toBeUndefined();
    expect(kindsOf(ga.events)).toEqual(['thinkingDelta', 'capability', 'error:outputLimit']);
    expect(ga.events[1]).toEqual({ kind: 'capability', label: '备用1', notices: [skippedForCompact('备用1')] });
    expect(errorsOf(ga.events)[0]).toEqual(mainError);
    expect(a.assistants()).toHaveLength(8);

    // [主力, 备用1 窗口 64,000, 备用2 窗口 1,000,000]：跳过备用1，换到不用压缩就放得下的备用2；备用2 收到的是原文，不是摘要
    const b = longChat(8);
    const cb = realContext(b);
    const summarizeB = vi.spyOn(cb.engine, 'summarize');
    const gb = await grouped(b, BIG, [
      { cfg: SMALL, reply: backupReply },
      { cfg: relay(1_000_000, { id: 'inst-big-2' }), reply: backupReply },
    ], { context: cb });
    expect([gb.main.hits.length, gb.backups[0].hits.length, gb.backups[1].hits.length]).toEqual([1, 0, 1]);
    expect(kindsOf(gb.events)).toEqual(['thinkingDelta', 'capability', 'fallback:outputLimit', 'textDelta', 'messagePersisted', 'turnEnd']);
    expect(gb.events[1]).toEqual({ kind: 'capability', label: '备用1', notices: [skippedForCompact('备用1')] });
    expect(hopsOf(gb.events)).toEqual([{ kind: 'fallback', from: '主力', to: '备用2', cause: 'outputLimit', reason: exhausted('主力', 8_192, FALLBACK_CAP_WAY) }]);
    expect(gb.events.at(-1)).toEqual(TURN_END);
    const sentB = JSON.stringify(gb.backups[1].hits[0].body.messages);
    expect(sentB).toContain('question 1: ');
    expect(sentB).not.toContain(SUMMARY_TEXT);
    expect(summarizeB).not.toHaveBeenCalled();
    expect(b.store.getLatestCompactMarker(b.sessionId)).toBeUndefined();
    expect(b.assistants().at(-1)!.parts).toEqual([{ type: 'text', value: 'from backup' }]);

    // 水位只到修剪档、但余量不足且没有可修剪的（备用1 手动最大输出 30,000、窗口 64,000，输入约 43,000）：轮首会修剪后再压缩——同样跳过
    const c = longChat(7, 12_300);
    const cc = realContext(c);
    const summarizeC = vi.spyOn(cc.engine, 'summarize');
    const decideC = vi.spyOn(cc.policy, 'decideWindow');
    const gc = await grouped(c, BIG, [{ cfg: relay(64_000, { id: 'inst-small-out', maxOutputTokens: 30_000 }), reply: backupReply }], { context: cc });
    // 前置：按备用1 的窗口第一次判水位是修剪档（65%–70%），这个输入下它的输出余量已经不足
    const firstC = tiersFor(decideC, 64_000)[0];
    expect(firstC).toMatchObject({ tier: 'offload' });
    expect(firstC.tokens).toBeGreaterThan(42_000);
    expect(firstC.tokens).toBeLessThan(44_800);
    expect([gc.main.hits.length, gc.backups[0].hits.length]).toEqual([1, 0]);
    expect(summarizeC).not.toHaveBeenCalled();
    expect(c.store.getLatestCompactMarker(c.sessionId)).toBeUndefined();
    expect(kindsOf(gc.events)).toEqual(['thinkingDelta', 'capability', 'error:outputLimit']);
    expect(gc.events[1]).toEqual({ kind: 'capability', label: '备用1', notices: [skippedForCompact('备用1')] });
    expect(errorsOf(gc.events)[0]).toEqual(mainError);
  });

  it('L40b 对照：接手的槽位只需修剪、或轮首本来就不会为它发摘要请求（没有可摘的、本次运行已停用压缩）——照常换过去，不写压缩记录', async () => {
    // 只需修剪：四个用户回合（摘要有东西可摘），备用1 窗口 32,000，余量不足（水位 67% 左右、没到档）；
    // 修剪掉两条旧的大结果后余量就够了，轮首不会再压缩（修剪只动请求，不落库）
    const p = mkCtx();
    p.say('task zero');
    p.add('assistant', [{ type: 'text', value: 'ok' }]);
    p.say('task one');
    p.rounds('A', [24_000, 24_000]);
    p.say('task two');
    p.rounds('B', [60, 60]);
    p.say('task three');
    p.rounds('C', [60, 60, 60, 36_000]);
    const cp = realContext(p);
    const summarizeP = vi.spyOn(cp.engine, 'summarize');
    const decideP = vi.spyOn(cp.policy, 'decideWindow');
    const gp = await grouped(p, BIG, [{ cfg: relay(32_000, { id: 'inst-small-32' }), reply: backupReply }], { context: cp });
    // 前置：按备用1 的窗口第一次判水位没到档（66%–70%），是余量不足触发的修剪
    const firstP = tiersFor(decideP, 32_000)[0];
    expect(firstP).toMatchObject({ tier: 'none' });
    expect(firstP.tokens / 32_000).toBeGreaterThan(0.66);
    expect([gp.main.hits.length, gp.backups[0].hits.length]).toEqual([1, 1]);
    expect(kindsOf(gp.events)).toEqual(['thinkingDelta', 'fallback:outputLimit', 'pruned', 'textDelta', 'messagePersisted', 'turnEnd']);
    expect(gp.events.filter(e => e.kind === 'pruned')).toEqual([{ kind: 'pruned', count: 2 }]);
    const outputs = toolOutputs(gp.backups[0].hits[0].body);
    expect(outputs).toHaveLength(8);
    expect(outputs[0].startsWith('[工具结果已修剪')).toBe(true);
    expect(outputs[1].startsWith('[工具结果已修剪')).toBe(true);
    expect(outputs[7]).toBe(ascii(36_000));
    expect(gp.budgets.map(x => [x.slot.label, x.status])).toEqual([['主力', 'ok'], ['备用1', 'ok']]);
    expect(summarizeP).not.toHaveBeenCalled();
    expect(p.store.getLatestCompactMarker(p.sessionId)).toBeUndefined();
    // 落库的工具结果仍是原文
    expect(p.store.listMessages(p.sessionId).filter(m => m.role === 'user').flatMap(m => m.parts)
      .some(x => x.type === 'toolResult' && (x.value as { output: string }).output === ascii(24_000))).toBe(true);

    // 没有可摘的（单个用户回合、不足 30 条）：修剪后余量仍不足，轮首会问一次压缩，但 summarize 不发请求、不写记录——不算要压缩
    const s = mkCtx();
    s.say('run the nine steps');
    s.rounds('T', [8_000, 8_000, 60, 24_000, 24_000, 24_000, 24_000, 24_000, 24_000]);
    const cs = realContext(s);
    const summarizeS = vi.spyOn(cs.engine, 'summarize');
    const gs = await grouped(s, BIG, [{ cfg: relay(48_000, { id: 'inst-small-48' }), reply: backupReply }], { context: cs });
    expect([gs.main.hits.length, gs.backups[0].hits.length]).toEqual([1, 1]);
    expect(kindsOf(gs.events)).toEqual(['thinkingDelta', 'fallback:outputLimit', 'pruned', 'textDelta', 'messagePersisted', 'turnEnd']);
    expect(isSummaryRequest(gs.backups[0].hits[0].body)).toBe(false);
    expect(gs.budgets.map(x => [x.slot.label, x.status])).toEqual([['主力', 'ok'], ['备用1', 'tight']]);
    expect(summarizeS).toHaveBeenCalledTimes(1);
    await expect(summarizeS.mock.results[0].value).resolves.toBeUndefined();
    expect(s.store.getLatestCompactMarker(s.sessionId)).toBeUndefined();

    // 本次运行已停用压缩（主力自己那次摘要请求失败了）：同样窗口的备用1 不会再压缩，主力刚发得出去的请求它也接得住
    const d = longChat(8);
    const cd = realContext(d);
    const gd = await grouped(d, relay(64_000, { id: 'inst-a' }), [{ cfg: relay(64_000, { id: 'inst-b' }), reply: backupReply }], {
      context: cd,
      mainReply: body => isSummaryRequest(body) ? new Response('{"error":{"message":"summary backend down"}}', { status: 500 }) : reasoningOnly(null),
    });
    expect(gd.main.hits.map(h => isSummaryRequest(h.body))).toEqual([true, false]);
    expect(gd.backups[0].hits.map(h => isSummaryRequest(h.body))).toEqual([false]);
    expect(kindsOf(gd.events)).toEqual(['compactFailed', 'thinkingDelta', 'fallback:outputLimit', 'textDelta', 'messagePersisted', 'turnEnd']);
    expect(gd.budgets.map(x => [x.slot.label, x.output.limitedBy])).toEqual([['主力', 'model'], ['备用1', 'model']]);
    expect(JSON.stringify(gd.backups[0].hits[0].body.messages)).toContain('question 1: ');
    expect(d.store.getLatestCompactMarker(d.sessionId)).toBeUndefined();
  });

  it('L41 按输出额度换槽之后链上的备用都没有接住这一轮：终态错误仍是最先被换下槽位的截断说明（它没有坏，出路在它身上），后面附上最后的故障原因，不说「所有模型均不可用」', async () => {
    const BIG2 = relay(1_000_000, { id: 'inst-big-2' });
    const BIG3 = relay(1_000_000, { id: 'inst-big-3' });
    const raw429 = await rawErrorOf(rateLimited);
    const mainInfo = { requested: 8_192, limitedBy: 'model', continued: 0 };

    // [主力(输出用完), 备用1(限流), 备用2(限流)]
    const a = mkCtx();
    a.say('think hard');
    const ga = await grouped(a, relay(64_000), [{ cfg: BIG, reply: rateLimited }, { cfg: BIG2, reply: rateLimited }]);
    expect([ga.main.hits.length, ga.backups[0].hits.length, ga.backups[1].hits.length]).toEqual([1, 1, 1]);
    expect(kindsOf(ga.events)).toEqual(['thinkingDelta', 'fallback:outputLimit', 'fallback:failure', 'error:outputLimit']);
    expect(ga.events.at(-1)).toEqual({
      kind: 'error', code: 'outputLimit', outputLimit: mainInfo,
      message: `${exhausted('主力', 8_192, FALLBACK_CAP_WAY)}${afterSwitch(raw429)}`,
    });
    expect((ga.events.at(-1) as { message: string }).message).not.toContain('所有模型均不可用');
    expect(a.assistants()).toEqual([]);

    // [主力(输出用完), 备用1(也用完，上限是它自己的), 备用2(限流)]：两个都没有坏，报最先被换下的那个
    const b = mkCtx();
    b.say('think hard');
    const gb = await grouped(b, relay(64_000), [{ cfg: BIG, reply: () => reasoningOnly(null) }, { cfg: BIG2, reply: rateLimited }]);
    expect(kindsOf(gb.events)).toEqual(['thinkingDelta', 'fallback:outputLimit', 'thinkingDelta', 'fallback:outputLimit', 'error:outputLimit']);
    expect(gb.events.at(-1)).toEqual({
      kind: 'error', code: 'outputLimit', outputLimit: mainInfo,
      message: `${exhausted('主力', 8_192, FALLBACK_CAP_WAY)}${afterSwitch(raw429)}`,
    });

    // [主力(限流), 备用1(输出用完), 备用2(限流)]：先是故障降级；备用1 没有坏，报它的截断说明
    const c = mkCtx();
    c.say('think hard');
    const gc = await grouped(c, relay(64_000), [{ cfg: BIG, reply: () => reasoningOnly(null) }, { cfg: BIG2, reply: rateLimited }], { mainReply: rateLimited });
    expect([gc.main.hits.length, gc.backups[0].hits.length, gc.backups[1].hits.length]).toEqual([1, 1, 1]);
    expect(kindsOf(gc.events)).toEqual(['fallback:failure', 'thinkingDelta', 'fallback:outputLimit', 'error:outputLimit']);
    expect(gc.events.at(-1)).toEqual({
      kind: 'error', code: 'outputLimit', outputLimit: mainInfo,
      message: `${exhausted('备用1', 8_192, FALLBACK_CAP_WAY)}${afterSwitch(raw429)}`,
    });

    // 接手的槽位重试用尽（500，可重试但不属于立刻降级的那类）且链已用尽：同样的终态
    const down = (): Response => new Response('{"error":{"message":"backend down (mock)"}}', { status: 500 });
    const raw500 = await rawErrorOf(down);
    const d = mkCtx();
    d.say('think hard');
    const gd = await grouped(d, relay(64_000), [{ cfg: BIG, reply: down }]);
    expect([gd.main.hits.length, gd.backups[0].hits.length]).toEqual([1, 2]);
    expect(kindsOf(gd.events)).toEqual(['thinkingDelta', 'fallback:outputLimit', 'retry', 'error:outputLimit']);
    expect(gd.events.at(-1)).toEqual({
      kind: 'error', code: 'outputLimit', outputLimit: mainInfo,
      message: `${exhausted('主力', 8_192, FALLBACK_CAP_WAY)}${afterSwitch(raw500)}`,
    });

    // 接手的槽位回了真正的空响应（正常收尾、什么都没有）且链已用尽
    const empty = (): Response => sse([{ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }], true);
    const e = mkCtx();
    e.say('think hard');
    const ge = await grouped(e, relay(64_000), [{ cfg: BIG, reply: empty }]);
    expect(kindsOf(ge.events)).toEqual(['thinkingDelta', 'fallback:outputLimit', 'error:outputLimit']);
    expect(ge.events.at(-1)).toEqual({
      kind: 'error', code: 'outputLimit', outputLimit: mainInfo,
      message: `${exhausted('主力', 8_192, FALLBACK_CAP_WAY)}${afterSwitch('模型返回了空响应')}`,
    });

    // 工具结果之后换的槽：接手的槽位回空响应、提醒一次后仍空，链已用尽——同样的终态
    const t = mkCtx();
    t.say('use the tool');
    const gt = await grouped(t, relay(64_000), [{ cfg: BIG, reply: empty }], { mainReply: (_body, n) => n === 0 ? openaiToolCall('call_1') : reasoningOnly(null) });
    expect([gt.main.hits.length, gt.backups[0].hits.length]).toEqual([2, 2]);
    expect(JSON.stringify(gt.backups[0].hits[1].body.messages)).toContain('系统提醒');
    expect(kindsOf(gt.events).slice(-3)).toEqual(['thinkingDelta', 'fallback:outputLimit', 'error:outputLimit']);
    expect(gt.events.at(-1)).toEqual({
      kind: 'error', code: 'outputLimit', outputLimit: mainInfo,
      message: `${exhausted('主力', 8_192, FALLBACK_CAP_WAY)}${afterSwitch('模型返回了空响应')}`,
    });

    // 对照：接手的槽位已经给出过回答（调了工具并落库），之后的轮次才故障——那一轮的换槽已经了结，报它自己的错误
    const h = mkCtx();
    h.say('use the tool');
    const gh = await grouped(h, relay(64_000), [{ cfg: BIG, reply: (_body, n) => n === 0 ? openaiToolCall('call_1') : down() }]);
    expect([gh.main.hits.length, gh.backups[0].hits.length]).toEqual([1, 3]);
    expect(kindsOf(gh.events).slice(0, 2)).toEqual(['thinkingDelta', 'fallback:outputLimit']);
    expect(gh.events.filter(x => x.kind === 'toolEnd')).toHaveLength(1);
    expect(gh.events.at(-1)).toEqual({ kind: 'error', message: raw500 });

    // 对照：没有按输出额度换过槽的纯故障链，仍是「所有模型均不可用」
    const f = mkCtx();
    f.say('think hard');
    const gf = await grouped(f, relay(64_000), [{ cfg: BIG, reply: rateLimited }, { cfg: BIG3, reply: rateLimited }], { mainReply: rateLimited });
    expect(kindsOf(gf.events)).toEqual(['fallback:failure', 'fallback:failure', 'error:所有模型均不可用']);
    expect(gf.events.at(-1)).toEqual({ kind: 'error', message: '所有模型均不可用' });
  });

  // ── 复审 R1：按输出额度换槽时，放不下这段对话的候选同样不接手（一次请求不发，说明后跳过）；换过之后、还没有槽位给出回答之前，
  // 不管从哪个出口收尾，报的都是最先被换下槽位的截断说明并附上最后的失败原因，不报「上下文已满」、不给接力草稿。

  /** 「放不下这段对话」的跳过说明：括号里是这个槽位修剪之后的预计输入（第 1 个捕获组）与它的窗口。 */
  const skippedForOver = (label: string, window: number): RegExp =>
    new RegExp(`^已跳过：${label} 放不下这段对话（预计输入约 (\\d+)，上下文窗口 ${window} 留不出余量与最小输出）；这次换用不是因为故障，不把这一轮发给它$`);
  const capabilityAt = (events: LoopEvent[], i: number) => events[i] as Extract<LoopEvent, { kind: 'capability' }>;

  it('L42 接手的槽位放不下这段对话（修剪之后预算仍是 over）：按输出额度换槽不把这一轮发给它——说明后跳过，往后找放得下的；链上再没有就照旧报截断，不报「上下文已满」', async () => {
    const SMALL = relay(32_000, { id: 'inst-small-32' });
    const mainError = {
      kind: 'error', code: 'outputLimit', outputLimit: { requested: 8_192, limitedBy: 'model', continued: 0 },
      message: exhausted('主力', 8_192, FALLBACK_CAP_WAY),
    };
    /** 单个用户回合加一条约 40,000 token 的工具结果：没有可摘的（压缩做不成），它在最近 12 条之内、修剪也动不到。 */
    const oneBigResult = (): Ctx => {
      const ctx = mkCtx();
      ctx.say('summarize the log');
      ctx.rounds('T', [160_000]);
      return ctx;
    };
    const strict32k = strictAll(32_000, () => openaiOk('never'));

    // [主力 窗口 1,000,000, 备用1 窗口 32,000（按窗口校验的端点）]，接了水位与压缩：对主力只占 4%，备用1 放不下。
    // 备用1 一个请求都没收到，报的是主力的那句说明（有出路、可重试），不是备用1 的「上下文已满」加接力草稿
    const a = oneBigResult();
    const ca = realContext(a);
    const summarizeA = vi.spyOn(ca.engine, 'summarize');
    const ga = await grouped(a, BIG, [{ cfg: SMALL, reply: strict32k }], { context: ca });
    expect([ga.main.hits.length, ga.backups[0].hits.length]).toEqual([1, 0]);
    expect(kindsOf(ga.events)).toEqual(['thinkingDelta', 'capability', 'error:outputLimit']);
    expect(capabilityAt(ga.events, 1).label).toBe('备用1');
    expect(capabilityAt(ga.events, 1).notices).toHaveLength(1);
    const said = skippedForOver('备用1', 32_000).exec(capabilityAt(ga.events, 1).notices[0]);
    expect(said, capabilityAt(ga.events, 1).notices[0]).not.toBeNull();
    expect(Number(said![1])).toBeGreaterThan(40_000);
    expect(Number(said![1])).toBeLessThan(41_000);
    expect(errorsOf(ga.events)[0]).toEqual(mainError);
    expect('relayDraft' in errorsOf(ga.events)[0]).toBe(false);
    expect(ga.budgets.map(x => x.slot.label)).toEqual(['主力']);
    expect(summarizeA).not.toHaveBeenCalled();
    expect(a.store.getLatestCompactMarker(a.sessionId)).toBeUndefined();

    // [主力, 备用1 窗口 32,000, 备用2 窗口 1,000,000]：跳过备用1，换到放得下的备用2；备用2 收到的是那条结果的原文。
    // 备用1 没有白收一次必被拒绝的请求，也没有因此多出一条「上下文已满」的换槽提示
    const b = oneBigResult();
    const gb = await grouped(b, BIG, [
      { cfg: SMALL, reply: strict32k },
      { cfg: relay(1_000_000, { id: 'inst-big-2' }), reply: () => openaiOk('from backup 2') },
    ], { context: realContext(b) });
    expect([gb.main.hits.length, gb.backups[0].hits.length, gb.backups[1].hits.length]).toEqual([1, 0, 1]);
    expect(kindsOf(gb.events)).toEqual(['thinkingDelta', 'capability', 'fallback:outputLimit', 'textDelta', 'messagePersisted', 'turnEnd']);
    expect(capabilityAt(gb.events, 1).label).toBe('备用1');
    expect(capabilityAt(gb.events, 1).notices[0]).toMatch(skippedForOver('备用1', 32_000));
    expect(hopsOf(gb.events)).toEqual([{ kind: 'fallback', from: '主力', to: '备用2', cause: 'outputLimit', reason: exhausted('主力', 8_192, FALLBACK_CAP_WAY) }]);
    expect(toolOutputs(gb.backups[1].hits[0].body)).toEqual([ascii(160_000)]);
    expect(gb.events.at(-1)).toEqual(TURN_END);

    // 没接水位与压缩的调用方：轮首不修剪，按原样的请求判——同样跳过
    const c = oneBigResult();
    const gc = await grouped(c, BIG, [{ cfg: SMALL, reply: strict32k }]);
    expect([gc.main.hits.length, gc.backups[0].hits.length]).toEqual([1, 0]);
    expect(kindsOf(gc.events)).toEqual(['thinkingDelta', 'capability', 'error:outputLimit']);
    expect(capabilityAt(gc.events, 1).notices[0]).toMatch(skippedForOver('备用1', 32_000));
    expect(errorsOf(gc.events)[0]).toEqual(mainError);

    // 对照：修剪之前放不下、轮首修剪掉三条旧的大结果之后放得下（余量仍紧，max_tokens 收紧）——照常接手。
    // 判的是轮首修剪之后真正会发的那份请求，不是原样的历史；单个用户回合没有可摘的，压缩不在其中
    const d = mkCtx();
    d.say('run the nine steps');
    d.rounds('T', Array.from({ length: 9 }, () => 24_000));
    const cd = realContext(d);
    const decideD = vi.spyOn(cd.policy, 'decideWindow');
    const gd = await grouped(d, BIG, [{ cfg: relay(48_000, { id: 'inst-small-48' }), reply: strictAll(48_000, () => openaiOk('from backup')) }], { context: cd });
    // 前置：原样的输入已经超过备用1 的窗口
    expect(tiersFor(decideD, 48_000)[0].tokens).toBeGreaterThan(48_000);
    expect([gd.main.hits.length, gd.backups[0].hits.length]).toEqual([1, 1]);
    expect(kindsOf(gd.events)).toEqual(['thinkingDelta', 'fallback:outputLimit', 'pruned', 'textDelta', 'messagePersisted', 'turnEnd']);
    expect(gd.events.filter(e => e.kind === 'pruned')).toEqual([{ kind: 'pruned', count: 3 }]);
    expect(gd.budgets.map(x => [x.slot.label, x.status])).toEqual([['主力', 'ok'], ['备用1', 'tight']]);
    expect(gd.events.at(-1)).toEqual(TURN_END);

    // 对照：同样的形状、窗口 64,000（这一档有压缩档）。原样的输入在压缩档上且放不下，压缩做不成（没有可摘的）——
    // 轮首这时退到修剪（减压第 ③ 步），修剪之后放得下：照常接手，不写压缩记录
    const e = mkCtx();
    e.say('run the nine steps');
    e.rounds('T', Array.from({ length: 9 }, () => 32_000));
    const ce = realContext(e);
    const decideE = vi.spyOn(ce.policy, 'decideWindow');
    const ge = await grouped(e, BIG, [{ cfg: relay(64_000, { id: 'inst-small-64' }), reply: strictAll(64_000, () => openaiOk('from backup')) }], { context: ce });
    // 前置：原样的输入超过备用1 的窗口，档位是压缩档
    expect(tiersFor(decideE, 64_000)[0]).toMatchObject({ tier: 'compact' });
    expect(tiersFor(decideE, 64_000)[0].tokens).toBeGreaterThan(64_000);
    expect([ge.main.hits.length, ge.backups[0].hits.length]).toEqual([1, 1]);
    expect(kindsOf(ge.events)).toEqual(['thinkingDelta', 'fallback:outputLimit', 'pruned', 'textDelta', 'messagePersisted', 'turnEnd']);
    expect(ge.events.filter(x => x.kind === 'pruned')).toEqual([{ kind: 'pruned', count: 3 }]);
    expect(ge.budgets.map(x => [x.slot.label, x.status])).toEqual([['主力', 'ok'], ['备用1', 'ok']]);
    expect(e.store.getLatestCompactMarker(e.sessionId)).toBeUndefined();
    expect(ge.events.at(-1)).toEqual(TURN_END);
  });

  /** 固定开销占满时的跳过说明：捕获组依次是系统提示、工具定义、工具个数、对话本身各约多少。 */
  const skippedForFixed = (label: string, window: number): RegExp =>
    new RegExp(`^已跳过：${label} 放不下这次请求的固定部分（系统提示约 (\\d+)、工具定义约 (\\d+)（(\\d+) 个）已占满上下文窗口 ${window}（估算），`
      + '对话本身约占 (\\d+)）；这次换用不是因为故障，不把这一轮发给它$');

  it('L42b 接手的槽位放不下的是请求的固定部分（系统提示与工具定义按估算已占满它的窗口；下界没超过，所以不是发送前拒发的 blocked）：照样说明后跳过，说明写的是固定开销与各项数字——不说成「放不下这段对话」，也不说成「要先压缩这段对话」', async () => {
    const SMALL = relay(32_000, { id: 'inst-small-32' });
    const BIG2 = relay(1_000_000, { id: 'inst-big-2' });
    /** 约 44,000 token 的系统提示：超过 32,000 的窗口，按下界（×0.7）没超过。 */
    const PROMPT_44K = ascii(176_000);
    const mainError = {
      kind: 'error', code: 'outputLimit', outputLimit: { requested: 8_192, limitedBy: 'model', continued: 0 },
      message: exhausted('主力', 8_192, FALLBACK_CAP_WAY),
    };
    const strict32k = strictAll(32_000, () => openaiOk('never'));

    // 取数：同一份请求经故障降级发给备用1（故障降级照发、由端点裁决）——它的预算是 over 而不是 blocked，
    // 撑满窗口的是系统提示，对话只有一句 hi。下面跳过说明里的数字要与这份预算逐项相同
    const k = mkCtx();
    k.say('hi');
    const gk = await grouped(k, BIG, [{ cfg: SMALL, reply: strict32k }], { systemPrompt: PROMPT_44K, mainReply: rateLimited });
    expect(kindsOf(gk.events)).toEqual(['fallback:failure', 'error:requestBudget']);
    const over = gk.budgets[1];
    expect([over.slot.label, over.status, over.limits.inputLimit]).toEqual(['备用1', 'over', 32_000]);
    const parts = over.input.components;
    const conversation = parts.history + parts.reasoningReplay + parts.media;
    expect(parts.system).toBe(44_000);
    expect(conversation).toBeLessThan(100);
    const expected = [parts.system, parts.tools, over.input.toolCount, conversation];

    // [主力 窗口 1,000,000, 备用1 窗口 32,000]，接了水位与压缩：备用1 一个请求都没收到，报的仍是主力的那句说明。
    // 跳过说明照实写固定开销：照「放不下这段对话」去缩短对话或新建会话，都减不掉系统提示
    const a = mkCtx();
    a.say('hi');
    const ca = realContext(a);
    const summarizeA = vi.spyOn(ca.engine, 'summarize');
    const ga = await grouped(a, BIG, [{ cfg: SMALL, reply: strict32k }], { systemPrompt: PROMPT_44K, context: ca });
    expect([ga.main.hits.length, ga.backups[0].hits.length]).toEqual([1, 0]);
    expect(kindsOf(ga.events)).toEqual(['thinkingDelta', 'capability', 'error:outputLimit']);
    expect(capabilityAt(ga.events, 1).label).toBe('备用1');
    expect(capabilityAt(ga.events, 1).notices).toHaveLength(1);
    const note = capabilityAt(ga.events, 1).notices[0];
    expect(note).not.toContain('放不下这段对话');
    expect(note).not.toContain('压缩');
    const said = skippedForFixed('备用1', 32_000).exec(note);
    expect(said, note).not.toBeNull();
    expect(said!.slice(1).map(Number)).toEqual(expected);
    expect(errorsOf(ga.events)[0]).toEqual(mainError);
    expect(ga.budgets.map(x => x.slot.label)).toEqual(['主力']);
    expect(summarizeA).not.toHaveBeenCalled();
    expect(a.store.getLatestCompactMarker(a.sessionId)).toBeUndefined();

    // 没接水位与压缩的调用方：同一句
    const b = mkCtx();
    b.say('hi');
    const gb = await grouped(b, BIG, [{ cfg: SMALL, reply: strict32k }], { systemPrompt: PROMPT_44K });
    expect([gb.main.hits.length, gb.backups[0].hits.length]).toEqual([1, 0]);
    expect(kindsOf(gb.events)).toEqual(['thinkingDelta', 'capability', 'error:outputLimit']);
    expect(capabilityAt(gb.events, 1).notices).toEqual([note]);
    expect(errorsOf(gb.events)[0]).toEqual(mainError);

    // [主力, 备用1 窗口 32,000, 备用2 窗口 1,000,000]：同一句说明后跳过备用1，换到放得下的备用2
    const c = mkCtx();
    c.say('hi');
    const gc = await grouped(c, BIG, [{ cfg: SMALL, reply: strict32k }, { cfg: BIG2, reply: () => openaiOk('from backup 2') }], { systemPrompt: PROMPT_44K, context: realContext(c) });
    expect([gc.main.hits.length, gc.backups[0].hits.length, gc.backups[1].hits.length]).toEqual([1, 0, 1]);
    expect(kindsOf(gc.events)).toEqual(['thinkingDelta', 'capability', 'fallback:outputLimit', 'textDelta', 'messagePersisted', 'turnEnd']);
    expect(gc.events[1]).toEqual({ kind: 'capability', label: '备用1', notices: [note] });
    expect(hopsOf(gc.events).map(x => [x.from, x.to, x.cause])).toEqual([['主力', '备用2', 'outputLimit']]);
    expect(gc.events.at(-1)).toEqual(TURN_END);

    // 对话也长、摘要有东西可摘（8 组长问答约 47,000 token）：轮首会先修剪再压缩，可压缩完固定开销仍占满窗口——
    // 说的仍是固定开销（对话本身的数字照实写），不说成「要先压缩这段对话才放得下」。
    // 对照：同样的对话、系统提示很短时，放不下的确实是对话，仍是「要先压缩」那一句
    const d = longChat(8);
    const cd = realContext(d);
    const summarizeD = vi.spyOn(cd.engine, 'summarize');
    const gd = await grouped(d, BIG, [{ cfg: SMALL, reply: backupReply }], { systemPrompt: PROMPT_44K, context: cd });
    expect([gd.main.hits.length, gd.backups[0].hits.length]).toEqual([1, 0]);
    expect(kindsOf(gd.events)).toEqual(['thinkingDelta', 'capability', 'error:outputLimit']);
    const noteD = capabilityAt(gd.events, 1).notices[0];
    expect(noteD).not.toContain('压缩');
    const saidD = skippedForFixed('备用1', 32_000).exec(noteD);
    expect(saidD, noteD).not.toBeNull();
    expect(saidD!.slice(1, 4).map(Number)).toEqual(expected.slice(0, 3));
    expect(Number(saidD![4])).toBeGreaterThan(46_000);
    expect(Number(saidD![4])).toBeLessThan(48_000);
    expect(summarizeD).not.toHaveBeenCalled();
    expect(d.store.getLatestCompactMarker(d.sessionId)).toBeUndefined();
    const d0 = longChat(8);
    const gd0 = await grouped(d0, BIG, [{ cfg: SMALL, reply: backupReply }], { context: realContext(d0) });
    expect([gd0.main.hits.length, gd0.backups[0].hits.length]).toEqual([1, 0]);
    expect(gd0.events[1]).toEqual({ kind: 'capability', label: '备用1', notices: [skippedForCompact('备用1')] });

    // 水位直接到压缩档的窗口（64,000，系统提示约 63,500）：同样说固定开销
    const e = longChat(8);
    const ce = realContext(e);
    const summarizeE = vi.spyOn(ce.engine, 'summarize');
    const decideE = vi.spyOn(ce.policy, 'decideWindow');
    const ge = await grouped(e, BIG, [{ cfg: relay(64_000, { id: 'inst-small' }), reply: backupReply }], { systemPrompt: ascii(254_000), context: ce });
    expect(tiersFor(decideE, 64_000)[0]).toMatchObject({ tier: 'compact' });
    expect([ge.main.hits.length, ge.backups[0].hits.length]).toEqual([1, 0]);
    expect(kindsOf(ge.events)).toEqual(['thinkingDelta', 'capability', 'error:outputLimit']);
    const noteE = capabilityAt(ge.events, 1).notices[0];
    expect(noteE).not.toContain('压缩');
    const saidE = skippedForFixed('备用1', 64_000).exec(noteE);
    expect(saidE, noteE).not.toBeNull();
    expect(Number(saidE![1])).toBe(63_500);
    expect(Number(saidE![4])).toBeGreaterThan(46_000);
    expect(summarizeE).not.toHaveBeenCalled();
    expect(e.store.getLatestCompactMarker(e.sessionId)).toBeUndefined();

    // 对照：系统提示不小（约 20,000）但自己占不满窗口，放不下的是那条约 40,000 token 的工具结果——仍是「放不下这段对话」
    const f = mkCtx();
    f.say('summarize the log');
    f.rounds('T', [160_000]);
    const gf = await grouped(f, BIG, [{ cfg: SMALL, reply: strict32k }], { systemPrompt: ascii(80_000), context: realContext(f) });
    expect([gf.main.hits.length, gf.backups[0].hits.length]).toEqual([1, 0]);
    expect(kindsOf(gf.events)).toEqual(['thinkingDelta', 'capability', 'error:outputLimit']);
    const saidF = skippedForOver('备用1', 32_000).exec(capabilityAt(gf.events, 1).notices[0]);
    expect(saidF, capabilityAt(gf.events, 1).notices[0]).not.toBeNull();
    expect(Number(saidF![1])).toBeGreaterThan(60_000);
  });

  it('L43 按输出额度换槽之后、还没有槽位给出回答之前，其余的终态出口同样报最先被换下槽位的截断说明并附上最后的失败原因：端点以超窗拒绝且没有更大的窗口、固定开销占满、思考块绑定、回到轮首固定部分放不下——不报「上下文已满」、不给接力草稿', async () => {
    const mainInfo = { requested: 8_192, limitedBy: 'model', continued: 0 };
    const mainSaid = exhausted('主力', 8_192, FALLBACK_CAP_WAY);
    const BIG2 = relay(1_000_000, { id: 'inst-big-2' });

    // ① 端点以超窗拒绝、链上没有窗口更大的成员。备用1 的窗口没有资料（按 128,000 判水位，预算恒为 ok——换槽之前看不出它放不下），
    //    它的端点实际只收 32,000。主力的窗口只用了 4%：出路在主力的输出上限上，不是「新建会话接力」
    const a = mkCtx();
    a.say('summarize the log');
    a.rounds('T', [160_000]);
    const NOWIN: RuntimeModelInput = { id: 'inst-nowin', kind: 'openai-compat', baseUrl: RELAY, modelId: 'unlisted-model' };
    const ga = await grouped(a, BIG, [{ cfg: NOWIN, reply: strictAll(32_000, () => openaiOk('never')) }], { context: realContext(a) });
    expect([ga.main.hits.length, ga.backups[0].hits.length]).toEqual([1, 1]);
    expect(ga.budgets.map(x => [x.slot.label, x.status, x.limits.windowKnown])).toEqual([['主力', 'ok', true], ['备用1', 'ok', false]]);
    expect(kindsOf(ga.events)).toEqual(['thinkingDelta', 'fallback:outputLimit', 'error:outputLimit']);
    const lastA = ga.events.at(-1) as Extract<LoopEvent, { kind: 'error' }>;
    expect(lastA).toEqual({ kind: 'error', code: 'outputLimit', outputLimit: mainInfo, message: `${mainSaid}${afterSwitch('上下文已满：备用1 放不下这段对话')}` });
    expect('relayDraft' in lastA).toBe(false);
    expect(lastA.message).not.toContain('接力');

    // ② 换过去的备用1 被限流，故障降级到备用2（故障降级照发、不经换槽之前的判断）；备用2 的端点以超窗拒绝，而它的固定开销
    //    自己就占满了窗口：最后的失败原因照实写固定开销。带的仍是主力的 outputLimit，没有 budget、没有接力草稿
    const b = mkCtx();
    b.say('hi');
    const gb = await grouped(b, BIG, [
      { cfg: BIG2, reply: rateLimited },
      { cfg: relay(32_000, { id: 'inst-small-32' }), reply: strictAll(32_000, () => openaiOk('never')) },
    ], { systemPrompt: ascii(176_000) });
    expect([gb.main.hits.length, gb.backups[0].hits.length, gb.backups[1].hits.length]).toEqual([1, 1, 1]);
    expect(gb.budgets.map(x => [x.slot.label, x.status])).toEqual([['主力', 'ok'], ['备用1', 'ok'], ['备用2', 'over']]);
    expect(kindsOf(gb.events)).toEqual(['thinkingDelta', 'fallback:outputLimit', 'fallback:failure', 'error:outputLimit']);
    const lastB = gb.events.at(-1) as Extract<LoopEvent, { kind: 'error' }>;
    expect(lastB).toEqual({ kind: 'error', code: 'outputLimit', outputLimit: mainInfo, message: `${mainSaid}${afterSwitch(fixedCostMessage('备用2', gb.budgets[2]))}` });
    expect(lastB.message).toContain('（最后的错误：备用2 拒绝了这次请求：系统提示约 44000、工具定义约 ');
    expect('budget' in lastB).toBe(false);
    expect('relayDraft' in lastB).toBe(false);

    // ③ 换过去的备用1 拒绝回放历史思考块（换模型解决不了，循环不再往后换）：同样的终态，绑定的说明附在后面
    const bound = (): Response => new Response('{"error":{"message":"The block is bound to a different conversation"}}', { status: 400 });
    const s = mkCtx();
    s.say('think hard');
    const rawBinding = errorsOf((await run(s, { primary: { provider: openai(BIG, captureBody(bound).fetchImpl), input: BIG } })).events)[0];
    expect(rawBinding.code).toBe('thinkingBinding');
    expect(rawBinding.message.startsWith('Claude 拒绝回放历史思考块')).toBe(true);
    const c = mkCtx();
    c.say('think hard');
    const gc = await grouped(c, relay(64_000), [{ cfg: BIG, reply: bound }, { cfg: BIG2, reply: () => openaiOk('never') }]);
    expect([gc.main.hits.length, gc.backups[0].hits.length, gc.backups[1].hits.length]).toEqual([1, 1, 0]);
    expect(kindsOf(gc.events)).toEqual(['thinkingDelta', 'fallback:outputLimit', 'error:outputLimit']);
    expect(gc.events.at(-1)).toEqual({ kind: 'error', code: 'outputLimit', outputLimit: mainInfo, message: `${mainSaid}${afterSwitch(rawBinding.message)}` });

    // ④ 换过去的备用1 回到轮首时固定部分放不下了（系统提示在两次求值之间变大；工厂每轮按槽位重新求值），链上再没有别的。
    //    这一轮发给过主力：不能说「本轮没有发送给任何模型」
    const GROW = relay(32_000, { id: 'inst-grow', modelId: 'unlisted-backup' });
    let backupPrompts = 0;
    const d = mkCtx();
    d.say('think hard');
    const gd = await grouped(d, BIG, [{ cfg: GROW, reply: () => openaiOk('never') }], {
      extra: { systemPrompt: sp => (sp.modelId === 'unlisted-backup' && ++backupPrompts > 1 ? ascii(200_000) : 'sys') },
    });
    expect(backupPrompts).toBe(2);
    expect([gd.main.hits.length, gd.backups[0].hits.length]).toEqual([1, 0]);
    expect(kindsOf(gd.events)).toEqual(['thinkingDelta', 'fallback:outputLimit', 'error:outputLimit']);
    const lastD = gd.events.at(-1) as Extract<LoopEvent, { kind: 'error' }>;
    expect(lastD.outputLimit).toEqual(mainInfo);
    expect(lastD.message.startsWith(`${mainSaid}。随后换用的备用模型也没有给出回答（最后的错误：备用1 放不下这次请求的固定部分（系统提示约 50000、`)).toBe(true);
    expect(lastD.message).not.toContain('本轮没有发送给任何模型');
    expect('budget' in lastD).toBe(false);

    // 对照：没有按输出额度换过槽时，这几个出口原样（L3 / L3c 钉着单槽位的；这里补故障降级之后的超窗）
    const f = mkCtx();
    // F03：同 L3c——放不下的 16 万字符放在用户消息里（工具结果会被裁成头尾后恢复），断言不变
    f.say(`summarize the log ${ascii(160_000)}`);
    const gf = await grouped(f, BIG, [{ cfg: NOWIN, reply: strictAll(32_000, () => openaiOk('never')) }], { context: realContext(f), mainReply: rateLimited });
    expect(kindsOf(gf.events)).toEqual(['fallback:failure', 'error:contextFull']);
    expect((gf.events.at(-1) as Extract<LoopEvent, { kind: 'error' }>).relayDraft).toContain('summarize the log');
  });

  it('L44 换用的那一刻不为接手的成员压缩；换过去之后对话继续增长、到了它的压缩档时，仍按它的窗口压缩并写下压缩记录——会话没有改绑，主力之后收到的是摘要（复审 R2：接受的行为，钉住）', async () => {
    // [主力 窗口 1,000,000, 备用1 窗口 64,000]：4 组长问答约 23,500 token，换槽时对备用1 只有 37% 左右（不到修剪档）——照常接手。
    // 备用1 第一次回复调工具，结果约 25,000 token，对话涨到它的压缩档（76% 左右）
    const SMALL = relay(64_000, { id: 'inst-small' });
    const ctx = longChat(4, 11_700, [bigEcho(100_000)]);
    const cx = realContext(ctx);
    const summarize = vi.spyOn(cx.engine, 'summarize');
    const decide = vi.spyOn(cx.policy, 'decideWindow');
    const reply = (body: Body): Response => isSummaryRequest(body) ? openaiOk(SUMMARY_TEXT)
      : toolOutputs(body).length === 0 ? openaiToolCall('call_1') : openaiOk('from backup');
    const g = await grouped(ctx, BIG, [{ cfg: SMALL, reply }], { context: cx });

    // 换用的那一刻：按备用1 的窗口第一次判水位不到档，没有跳过它，也没有先发摘要请求
    expect(tiersFor(decide, 64_000)[0]).toMatchObject({ tier: 'none' });
    expect(kindsOf(g.events)).toEqual([
      'thinkingDelta', 'fallback:outputLimit', 'messagePersisted', 'toolStart', 'toolEnd', 'messagePersisted', 'compacted', 'textDelta', 'messagePersisted', 'turnEnd',
    ]);
    expect(hopsOf(g.events)).toEqual([{ kind: 'fallback', from: '主力', to: '备用1', cause: 'outputLimit', reason: exhausted('主力', 8_192, FALLBACK_CAP_WAY) }]);
    // 备用1 收到：正式请求（原文）、摘要请求、正式请求（摘要 + 最近的原文与那条工具结果）
    expect(g.main.hits).toHaveLength(1);
    expect(g.backups[0].hits.map(h => isSummaryRequest(h.body))).toEqual([false, true, false]);
    expect(JSON.stringify(g.backups[0].hits[0].body.messages)).toContain('question 1: ');
    const afterCompact = JSON.stringify(g.backups[0].hits[2].body.messages);
    // F03：压缩后的请求在程序记录里带第一条用户指示的原话，超过 800 字符只留头 600、尾 200 并注明省略了中间。所以开头那几个字会出现，
    // 但头部到 600 个字符为止：「question 1: 」后面跟满 600 个字符的前缀（共 612）已经越过截断点，不该出现——截断失效或带出大半原文时这里会红
    expect(afterCompact).not.toContain(`question 1: ${ascii(600)}`);
    expect(afterCompact).toContain('（原话过长，已省略中间部分）');
    expect(afterCompact).toContain(SUMMARY_TEXT);
    expect(toolOutputs(g.backups[0].hits[2].body)).toEqual([ascii(100_000)]);
    // 涨过压缩档的那一次是按备用1 的窗口判的；主力只判过一次、不到档
    expect(tiersFor(decide, 64_000).map(x => x.tier)).toContain('compact');
    expect(tiersFor(decide, 1_000_000).map(x => x.tier)).toEqual(['none']);
    // 一次摘要、一条压缩记录
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(g.events.filter(e => e.kind === 'compacted')).toHaveLength(1);
    const marker = ctx.store.getLatestCompactMarker(ctx.sessionId);
    expect(marker?.summary).toContain(SUMMARY_TEXT);
    expect(g.events.at(-1)).toEqual(TURN_END);

    // 这次运行唯一的换槽事件带 cause:'outputLimit'——index.ts 不据此改绑（端到端见 E13 / E17）。同一个组再发一条：
    // 先收到请求的仍是主力，它的窗口只用了不到 5%，拿到的却是摘要，不是早先的原文
    ctx.say('next question');
    const again = await grouped(ctx, BIG, [{ cfg: SMALL, reply }], { context: realContext(ctx), mainReply: () => openaiOk('from main') });
    expect([again.main.hits.length, again.backups[0].hits.length]).toEqual([1, 0]);
    const mainBody = JSON.stringify(again.main.hits[0].body.messages);
    expect(mainBody).toContain(SUMMARY_TEXT);
    expect(mainBody).not.toContain(`question 1: ${ascii(600)}`);
    expect(mainBody).toContain('（原话过长，已省略中间部分）');
    expect(again.budgets[0].slot.label).toBe('主力');
    expect(again.budgets[0].input.tokens / again.budgets[0].limits.inputLimit).toBeLessThan(0.05);
    expect(again.events.at(-1)).toEqual(TURN_END);
  });

  it('L45 按输出额度换过去的成员自己回了空响应、再换到后面的小窗口成员：这一跳是故障降级，回到轮首按新接手成员的窗口压缩并写下压缩记录——对话没有增长也照样；会话没有改绑，主力之后收到的是摘要（终审：与 L44 同一口径的接受行为，钉住）', async () => {
    // [主力 窗口 1,000,000, 备用1 窗口 1,000,000, 备用2 窗口 64,000]：8 组长问答约 47,000 token，对前两个不到 5%，对备用2 在压缩档（73% 左右）。
    // 直接 [主力, 备用2] 时，备用2 会按「要先压缩这段对话才放得下这一轮」跳过（L40）；这里中间隔着一个出了故障的备用1
    const BIG2 = relay(1_000_000, { id: 'inst-big-2' });
    const SMALL = relay(64_000, { id: 'inst-small' });
    const empty = (): Response => sse([{ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }], true);
    const mainHop = { kind: 'fallback', from: '主力', to: '备用1', cause: 'outputLimit', reason: exhausted('主力', 8_192, FALLBACK_CAP_WAY) };

    const a = longChat(8);
    const ca = realContext(a);
    const summarizeA = vi.spyOn(ca.engine, 'summarize');
    const decideA = vi.spyOn(ca.policy, 'decideWindow');
    const backups = [{ cfg: BIG2, reply: empty }, { cfg: SMALL, reply: backupReply }];
    const ga = await grouped(a, BIG, backups, { context: ca });
    // 两跳：第一跳按输出额度（挑槽位时过了「要先压缩 / 放不下」的判断，备用1 窗口大、照常接手）；第二跳是空响应——按故障降级，不带 cause
    expect(kindsOf(ga.events)).toEqual(['thinkingDelta', 'fallback:outputLimit', 'fallback:failure', 'compacted', 'textDelta', 'messagePersisted', 'turnEnd']);
    expect(hopsOf(ga.events)).toEqual([mainHop, { kind: 'fallback', from: '备用1', to: '备用2', reason: '空响应' }]);
    // 备用2 没有因为「要先压缩」被跳过：空响应这一跳不过那道判断
    expect(ga.events.some(e => e.kind === 'capability')).toBe(false);
    // 请求：主力 1 次、备用1 1 次（原文）、备用2 2 次——摘要请求、正式请求（摘要 + 最近的原文）
    expect([ga.main.hits.length, ga.backups[0].hits.length]).toEqual([1, 1]);
    expect(JSON.stringify(ga.backups[0].hits[0].body.messages)).toContain('question 1: ');
    expect(ga.backups[1].hits.map(h => isSummaryRequest(h.body))).toEqual([true, false]);
    const afterCompact = JSON.stringify(ga.backups[1].hits[1].body.messages);
    expect(afterCompact).toContain(SUMMARY_TEXT);
    // F03：压缩后的请求在程序记录里带第一条用户指示的原话，超过 800 字符只留头 600、尾 200 并注明省略了中间。所以开头那几个字会出现，
    // 但头部到 600 个字符为止：「question 1: 」后面跟满 600 个字符的前缀（共 612）已经越过截断点，不该出现——截断失效或带出大半原文时这里会红
    expect(afterCompact).not.toContain(`question 1: ${ascii(600)}`);
    expect(afterCompact).toContain('（原话过长，已省略中间部分）');
    // 压缩是按备用2 的窗口判的（回到轮首的第一次就是压缩档）；窗口 1,000,000 的两个成员每次都不到档
    expect(tiersFor(decideA, 64_000)[0]).toMatchObject({ tier: 'compact' });
    expect(tiersFor(decideA, 1_000_000).length).toBeGreaterThan(0);
    expect(tiersFor(decideA, 1_000_000).every(x => x.tier === 'none')).toBe(true);
    // 一次摘要、一条压缩记录；备用2 的回答照常落库
    expect(summarizeA).toHaveBeenCalledTimes(1);
    expect(ga.events.filter(e => e.kind === 'compacted')).toHaveLength(1);
    expect(a.store.getLatestCompactMarker(a.sessionId)?.summary).toContain(SUMMARY_TEXT);
    expect(a.assistants().at(-1)!.parts).toEqual([{ type: 'text', value: 'from backup' }]);
    expect(ga.events.at(-1)).toEqual(TURN_END);

    // 第一跳带 cause:'outputLimit'——index.ts 按第一跳算，随后的故障降级同样不改绑（端到端见 E15 第二段 / E18）。同一个组再发一条：
    // 先收到请求的仍是主力，它的窗口只用了不到 5%，拿到的却是摘要，不是早先的原文
    a.say('next question');
    const again = await grouped(a, BIG, backups, { context: realContext(a), mainReply: () => openaiOk('from main') });
    expect([again.main.hits.length, again.backups[0].hits.length, again.backups[1].hits.length]).toEqual([1, 0, 0]);
    const mainBody = JSON.stringify(again.main.hits[0].body.messages);
    expect(mainBody).toContain(SUMMARY_TEXT);
    expect(mainBody).not.toContain(`question 1: ${ascii(600)}`);
    expect(mainBody).toContain('（原话过长，已省略中间部分）');
    expect(again.budgets[0].slot.label).toBe('主力');
    expect(again.budgets[0].input.tokens / again.budgets[0].limits.inputLimit).toBeLessThan(0.05);
    expect(again.events.at(-1)).toEqual(TURN_END);

    // 对照：备用1 是被限流（立刻降级的那类故障）——在降级循环里当场换槽、不回轮首，备用2 这一轮收到的是原文，不压缩、不写记录
    const b = longChat(8);
    const cb = realContext(b);
    const summarizeB = vi.spyOn(cb.engine, 'summarize');
    const gb = await grouped(b, BIG, [{ cfg: BIG2, reply: rateLimited }, { cfg: SMALL, reply: backupReply }], { context: cb });
    expect(kindsOf(gb.events)).toEqual(['thinkingDelta', 'fallback:outputLimit', 'fallback:failure', 'textDelta', 'messagePersisted', 'turnEnd']);
    expect(hopsOf(gb.events)[0]).toEqual(mainHop);
    expect([gb.main.hits.length, gb.backups[0].hits.length]).toEqual([1, 1]);
    expect(gb.backups[1].hits.map(h => isSummaryRequest(h.body))).toEqual([false]);
    expect(JSON.stringify(gb.backups[1].hits[0].body.messages)).toContain('question 1: ');
    expect(summarizeB).not.toHaveBeenCalled();
    expect(b.store.getLatestCompactMarker(b.sessionId)).toBeUndefined();
    expect(gb.events.at(-1)).toEqual(TURN_END);
  });
});

describe('方案 6：工具顺序确定、系统提示分稳定段与动态段', () => {
  it('L16 MCP 工具的注册顺序倒过来：请求体里的工具顺序不变，内置在前', async () => {
    const cfg = relay(128_000);
    const names = async (tools: ToolExecutor[]): Promise<string[]> => {
      const ctx = mkCtx({ tools });
      ctx.say('hi');
      const ep = captureBody(() => openaiOk('ok'));
      await run(ctx, { primary: { provider: openai(cfg, ep.fetchImpl), input: cfg } });
      return (ep.hits[0].body.tools as Body[]).map(t => t.function.name as string);
    };
    const first = await names([echoTool, namedTool('mcp__b__x'), namedTool('mcp__a__y')]);
    const second = await names([echoTool, namedTool('mcp__a__y'), namedTool('mcp__b__x')]);
    expect(first).toEqual(['echo', 'mcp__a__y', 'mcp__b__x']);
    expect(second).toEqual(first);
  });

  it('L17 工厂返回两段：Anthropic 的 system 两块、断点只在稳定段；OpenAI 用拼好的全文；每轮每槽位工厂只调一次', async () => {
    let calls = 0;
    const factory = () => { calls++; return { stable: 'STABLE persona and rules', dynamic: `memory v${calls}` }; };
    // Anthropic：第一轮回工具调用，第二轮结束
    const a = mkCtx();
    a.say('use the tool');
    const cfg: RuntimeModelInput = { id: 'inst-claude', kind: 'anthropic', modelId: 'claude-x' };
    const ep = captureBody((_body, n) => n === 0 ? anthropicToolCall('toolu_1') : anthropicOk('done'));
    const { events } = await run(a, { primary: { provider: new AnthropicProvider({ apiKey: 'k', modelId: 'claude-x', fetchImpl: ep.fetchImpl }), input: cfg }, systemPrompt: factory });
    expect(events.at(-1)).toEqual(TURN_END);
    expect(ep.hits).toHaveLength(2);
    expect(calls).toBe(2);
    const [s1, s2] = ep.hits.map(h => h.body.system as Body[]);
    expect(s1).toEqual([{ type: 'text', text: 'STABLE persona and rules', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'memory v1' }]);
    expect(s2[1]).toEqual({ type: 'text', text: 'memory v2' });
    expect(JSON.stringify(s2[0])).toBe(JSON.stringify(s1[0]));
    // 断点总数不超过 4：工具 1、稳定段 1、最近两条 user 消息各 1
    expect(JSON.stringify(ep.hits[1].body).split('"cache_control"').length - 1).toBe(4);

    // OpenAI：system 消息是两段拼好的全文
    calls = 0;
    const o = mkCtx();
    o.say('hi');
    const relayCfg = relay(128_000);
    const oep = captureBody(() => openaiOk('ok'));
    const second = await run(o, { primary: { provider: openai(relayCfg, oep.fetchImpl), input: relayCfg }, systemPrompt: factory });
    expect(calls).toBe(1);
    expect(oep.hits[0].body.messages[0]).toEqual({ role: 'system', content: 'STABLE persona and rules\n\nmemory v1' });
    expect(second.budgets[0].input.systemStable + second.budgets[0].input.systemDynamic).toBe(second.budgets[0].input.components.system);
    expect(second.budgets[0].input.systemDynamic).toBeGreaterThan(0);
  });
});
