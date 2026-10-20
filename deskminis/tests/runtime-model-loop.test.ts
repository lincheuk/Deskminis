/**
 * F01 验收 2 / 3 / 5 的请求体证据：真 Agent 循环 + 真 Anthropic / OpenAI 构建器 + 注入的 fetch，抓下实际发出的 JSON 逐项断言。
 * 不是只测 resolver：主模型与备用模型的 max_tokens、推理参数、工具定义、图片在降级前后各自正确，
 * 接不了这一轮的槽位一次请求都不发，所有兼容处理都有事件说明。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgentLoop, type LoopEvent, type ProviderSlot, type SystemPromptCtx } from '../src/minisd/agent/loop';
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
import type { AgentProvider, FetchLike } from '../src/minisd/providers/types';
import type { ContentPart, ThinkingLevel } from '../src/shared/types';
import { EXAMPLE_APIS, catalogFixture, catalogFixtureF01R, jsonResponse } from './runtime-model-fixture';
import { snapshotExcerpt } from './runtime-model-snapshot-fixture';

let dir: string;
let catalog: ModelCatalog;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dm-runtime-loop-'));
  catalog = new ModelCatalog(join(dir, 'catalog.json'), async () => jsonResponse(catalogFixture()));
  await catalog.refresh(true);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const VENDOR_A: RuntimeModelInput = { kind: 'openai-compat', baseUrl: EXAMPLE_APIS.vendorA, modelId: 'shared-model' };
const VENDOR_B: RuntimeModelInput = { kind: 'openai-compat', baseUrl: EXAMPLE_APIS.vendorB, modelId: 'shared-model' };
const CLAUDE: RuntimeModelInput = { kind: 'anthropic', modelId: 'claude-x' };

const echoTool: ToolExecutor = {
  definition: { name: 'echo', description: 'echo', parameters: { text: { type: 'string', description: 't' }, tool_title: { type: 'string', description: 't' } }, required: ['text', 'tool_title'] },
  async execute(input) { return { output: `echo:${String(input.text)}`, success: true }; },
};
const TINY_PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f030005fe02fea72d99480000000049454e44ae426082', 'hex');

function mkCtx() {
  const store = new ChatStore(openDb(':memory:'));
  const s = store.createSession();
  const tools = new ToolRegistry(); tools.register(echoTool);
  const paths = new MinisPaths(join(dir, 'root')); paths.ensureSessionDirs(s.id);
  const toolContext: ToolContext = { sessionId: s.id, paths, permissions: { async check() { return 'allow'; }, hasBridgeGrant: () => false } };
  // listMessages 按 (created_at, id) 排序、nowEpoch 只到毫秒：同一毫秒里连着追加会按随机 id 排，这里给严格递增的时间
  let at = store.nowEpoch();
  const add = (role: 'user' | 'assistant', parts: ContentPart[]) =>
    store.appendMessage({ id: store.newId(), sessionId: s.id, role, parts, createdAt: (at += 0.01), streamInterruptCount: 0 });
  const image = (name: string): ContentPart => {
    writeFileSync(join(paths.sessionBucket(s.id, 'attachments'), name), TINY_PNG);
    return { type: 'mediaRef', value: { id: name, relativePath: `attachments/${name}`, mimeType: 'image/png' } };
  };
  return { store, tools, toolContext, sessionId: s.id, add, image };
}

/** 抓请求体的 fetch：按调用顺序记录 URL 与解析后的 JSON，响应由 respond 决定。 */
function capture(respond: (n: number) => Response) {
  const hits: { url: string; body: Record<string, any> }[] = [];
  const fetchImpl = (async (url: unknown, init?: { body?: unknown }) => {
    hits.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return respond(hits.length - 1);
  }) as unknown as FetchLike;
  return { hits, fetchImpl };
}
const sse = (frames: unknown[], done: boolean) =>
  new Response(frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : ''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const openaiOk = (text: string) => sse([{ choices: [{ index: 0, delta: { content: text } }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }], true);
const anthropicOk = (text: string) => sse([
  { type: 'message_start', message: { usage: { input_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
], false);
const rateLimited = () => new Response(JSON.stringify({ error: { message: 'rate limited (mock)' } }), { status: 429 });

async function run(ctx: ReturnType<typeof mkCtx>, opts: {
  primary: { provider: AgentProvider; input?: RuntimeModelInput };
  fallback?: { provider: AgentProvider; input?: RuntimeModelInput }[];
  thinkingLevel?: ThinkingLevel;
  /** 解析用的目录；缺省是 beforeEach 建的 catalogFixture。 */
  catalog?: ModelCatalog;
  /** true：接上真 ContextPolicy 与真 CompactEngine（水位判断、压缩走真实路径）。 */
  context?: boolean;
  signal?: AbortSignal;
  systemPrompt?: (ctx: SystemPromptCtx) => string;
}): Promise<LoopEvent[]> {
  const cat = opts.catalog ?? catalog;
  const chain: ProviderSlot[] = (opts.fallback ?? []).map((f, i) => ({
    provider: f.provider, label: `备用${i + 1}`, ...(f.input ? { runtime: resolveRuntimeModel(f.input, cat) } : {}),
  }));
  const events: LoopEvent[] = [];
  for await (const e of runAgentLoop(ctx.store, {
    sessionId: ctx.sessionId, tools: ctx.tools, toolContext: ctx.toolContext, systemPrompt: opts.systemPrompt ?? 'sys', retryDelaysMs: [0],
    provider: opts.primary.provider, primaryLabel: '主力',
    ...(opts.primary.input ? { primaryRuntime: resolveRuntimeModel(opts.primary.input, cat) } : {}),
    fallbackChain: chain, thinkingLevel: opts.thinkingLevel ?? 'off',
    ...(opts.context ? { contextPolicy: new ContextPolicy(cat), compactEngine: new CompactEngine(ctx.store) } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  })) events.push(e);
  return events;
}

describe('验收 2：降级前后的推理参数与输出上限都合法（抓实际请求体）', () => {
  it('主模型（官方 Anthropic，支持推理预算）429 → 备用（不支持推理、不支持工具）：备用请求不带推理参数、不带工具、max_tokens 用它自己的', async () => {
    const ctx = mkCtx();
    ctx.add('user', [{ type: 'text', value: '先查一下' }]);
    ctx.add('assistant', [{ type: 'toolUse', value: { toolUseId: 'T1', name: 'echo', input: '{"text":"a","tool_title":"查"}' } }]);
    ctx.add('user', [{ type: 'toolResult', value: { toolUseId: 'T1', output: 'echo:a', success: true, status: 'success' } }]);
    ctx.add('assistant', [{ type: 'text', value: '查到了' }]);
    ctx.add('user', [{ type: 'text', value: '继续' }]);
    const main = capture(() => rateLimited());
    const backup = capture(() => openaiOk('备用回复'));
    const events = await run(ctx, {
      primary: { provider: new AnthropicProvider({ apiKey: 'k', modelId: 'claude-x', fetchImpl: main.fetchImpl }), input: CLAUDE },
      fallback: [{ provider: new OpenAIProvider({ apiKey: 'k', modelId: 'shared-model', baseUrl: EXAMPLE_APIS.vendorB, fetchImpl: backup.fetchImpl }), input: VENDOR_B }],
      thinkingLevel: 'high',
    });
    expect(events.at(-1)).toEqual({ kind: 'turnEnd', stopReason: 'endTurn' });
    // 主模型：官方端点记录的输出上限 64000、推理预算夹在 [1024, max_tokens) 内
    expect(main.hits).toHaveLength(1);
    expect(main.hits[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(main.hits[0].body.max_tokens).toBe(64_000);
    expect(main.hits[0].body.thinking).toEqual({ type: 'enabled', budget_tokens: 63_999 });
    expect(main.hits[0].body.tools.map((t: { name: string }) => t.name)).toEqual(['echo']);
    // 备用：不沿用主模型的推理参数与输出上限；不支持工具 → 不写 tools 键，历史工具记录改成文字
    const b = backup.hits[0].body;
    expect(backup.hits).toHaveLength(1);
    expect(b.max_tokens).toBe(8_000);
    expect('reasoning_effort' in b).toBe(false);
    expect('tools' in b).toBe(false);
    expect(JSON.stringify(b.messages)).toContain('[历史工具调用] echo');
    expect(b.messages.some((m: { role: string; tool_calls?: unknown }) => m.role === 'tool' || m.tool_calls)).toBe(false);
    // 不静默：降级与两条兼容处理都说出来
    expect(events.find(e => e.kind === 'fallback')).toMatchObject({ from: '主力', to: '备用1' });
    const notice = events.find(e => e.kind === 'capability');
    expect(notice).toMatchObject({ label: '备用1' });
    expect((notice as { notices: string[] }).notices.join('\n')).toMatch(/不支持推理[\s\S]*不支持工具调用/);
  });

  it('反向：主模型不支持推理 429 → 备用支持（只接受 low/high/max）：主请求无推理参数，备用请求 medium 映射成 low', async () => {
    const ctx = mkCtx();
    ctx.add('user', [{ type: 'text', value: '想一想' }]);
    const main = capture(() => rateLimited());
    const backup = capture(() => openaiOk('想好了'));
    const events = await run(ctx, {
      primary: { provider: new OpenAIProvider({ apiKey: 'k', modelId: 'shared-model', baseUrl: EXAMPLE_APIS.vendorB, fetchImpl: main.fetchImpl }), input: VENDOR_B },
      fallback: [{ provider: new OpenAIProvider({ apiKey: 'k', modelId: 'shared-model', baseUrl: EXAMPLE_APIS.vendorA, fetchImpl: backup.fetchImpl }), input: VENDOR_A }],
      thinkingLevel: 'medium',
    });
    expect(events.at(-1)).toEqual({ kind: 'turnEnd', stopReason: 'endTurn' });
    expect(main.hits[0].url).toBe(`${EXAMPLE_APIS.vendorB}/chat/completions`);
    expect('reasoning_effort' in main.hits[0].body).toBe(false);
    expect(main.hits[0].body.max_tokens).toBe(8_000);
    expect(backup.hits[0].url).toBe(`${EXAMPLE_APIS.vendorA}/chat/completions`);
    expect(backup.hits[0].body.reasoning_effort).toBe('low');
    expect(backup.hits[0].body.max_tokens).toBe(32_000);
    expect(backup.hits[0].body.tools.map((t: { function: { name: string } }) => t.function.name)).toEqual(['echo']);
    const notices = events.filter(e => e.kind === 'capability').flatMap(e => (e as { notices: string[] }).notices);
    expect(notices.some(n => n.includes('medium 改为 low'))).toBe(true);
  });

  it('推理预算放不下：手动把输出上限改成 1000 的 Anthropic 槽位，请求不带 thinking、max_tokens=1000', async () => {
    const ctx = mkCtx();
    ctx.add('user', [{ type: 'text', value: 'hi' }]);
    const main = capture(() => anthropicOk('ok'));
    await run(ctx, {
      primary: { provider: new AnthropicProvider({ apiKey: 'k', modelId: 'claude-x', fetchImpl: main.fetchImpl }), input: { ...CLAUDE, maxOutputTokens: 1_000 } },
      thinkingLevel: 'low',
    });
    expect(main.hits[0].body.max_tokens).toBe(1_000);
    expect('thinking' in main.hits[0].body).toBe(false);
  });

  it('没有 runtime 的旧调用方：推理档位原样发送（行为与 F01 之前一致）', async () => {
    const ctx = mkCtx();
    ctx.add('user', [{ type: 'text', value: 'hi' }]);
    const main = capture(() => openaiOk('ok'));
    await run(ctx, { primary: { provider: new OpenAIProvider({ apiKey: 'k', modelId: 'shared-model', baseUrl: EXAMPLE_APIS.vendorB, fetchImpl: main.fetchImpl }) }, thinkingLevel: 'medium' });
    expect(main.hits[0].body.reasoning_effort).toBe('medium');
    expect(main.hits[0].body.max_tokens).toBe(4096);
  });
});

describe('验收 3 / 5：图片与工具的兼容路径，不静默丢附件', () => {
  it('本轮带图片、主模型不收图片：主模型一次请求都不发，按能力切到收图片的备用，图片原样发出', async () => {
    const ctx = mkCtx();
    ctx.add('user', [{ type: 'text', value: '看图' }, ctx.image('a.png')]);
    const main = capture(() => openaiOk('不该被请求'));
    const backup = capture(() => openaiOk('看到了'));
    const events = await run(ctx, {
      primary: { provider: new OpenAIProvider({ apiKey: 'k', modelId: 'shared-model', baseUrl: EXAMPLE_APIS.vendorB, fetchImpl: main.fetchImpl }), input: VENDOR_B },
      fallback: [{ provider: new OpenAIProvider({ apiKey: 'k', modelId: 'shared-model', baseUrl: EXAMPLE_APIS.vendorA, fetchImpl: backup.fetchImpl }), input: VENDOR_A }],
    });
    expect(main.hits).toHaveLength(0);
    expect(events.find(e => e.kind === 'fallback')).toMatchObject({ from: '主力', to: '备用1', cause: 'capability' });
    expect((events.find(e => e.kind === 'fallback') as { reason: string }).reason).toContain('不支持图片输入');
    const content = backup.hits[0].body.messages.find((m: { role: string }) => m.role === 'user').content;
    expect(content).toEqual([
      { type: 'text', text: '看图' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${TINY_PNG.toString('base64')}` } },
    ]);
    expect(events.at(-1)).toEqual({ kind: 'turnEnd', stopReason: 'endTurn' });
  });

  it('按能力换到的槽位随后失败、链已用尽：报它自己的原始错误，不笼统说「所有模型均不可用」', async () => {
    const ctx = mkCtx();
    ctx.add('user', [{ type: 'text', value: '看图' }, ctx.image('d.png')]);
    const main = capture(() => openaiOk('不该被请求'));
    const backup = capture(() => new Response(JSON.stringify({ error: { message: 'invalid api key (mock)' } }), { status: 401 }));
    const events = await run(ctx, {
      primary: { provider: new OpenAIProvider({ apiKey: 'k', modelId: 'shared-model', baseUrl: EXAMPLE_APIS.vendorB, fetchImpl: main.fetchImpl }), input: VENDOR_B },
      fallback: [{ provider: new OpenAIProvider({ apiKey: 'k', modelId: 'shared-model', baseUrl: EXAMPLE_APIS.vendorA, fetchImpl: backup.fetchImpl }), input: VENDOR_A }],
    });
    expect(main.hits).toHaveLength(0);
    expect(backup.hits).toHaveLength(1);
    const err = events.at(-1) as { kind: string; message: string };
    expect(err.kind).toBe('error');
    expect(err.message).toContain('invalid api key (mock)');
  });

  it('整条链都不收图片：一次请求都不发，报 capability 错误并说明出路；附件仍在库里', async () => {
    const ctx = mkCtx();
    ctx.add('user', [{ type: 'text', value: '看图' }, ctx.image('b.png')]);
    const main = capture(() => openaiOk('不该被请求'));
    const events = await run(ctx, {
      primary: { provider: new OpenAIProvider({ apiKey: 'k', modelId: 'shared-model', baseUrl: EXAMPLE_APIS.vendorB, fetchImpl: main.fetchImpl }), input: VENDOR_B },
    });
    expect(main.hits).toHaveLength(0);
    const err = events.at(-1) as { kind: string; code?: string; message: string };
    expect(err).toMatchObject({ kind: 'error', code: 'capability' });
    expect(err.message).toContain('不支持图片输入');
    expect(err.message).toContain('移除图片');
    expect(ctx.store.listMessages(ctx.sessionId)[0].parts.some(p => p.type === 'mediaRef')).toBe(true);
  });

  it('上一轮的图片、这一轮换成不收图片的模型：图片改成说明文字发出，并提示用户', async () => {
    const ctx = mkCtx();
    ctx.add('user', [{ type: 'text', value: '这张图' }, ctx.image('c.png')]);
    ctx.add('assistant', [{ type: 'text', value: '是一只猫' }]);
    ctx.add('user', [{ type: 'text', value: '换个话题' }]);
    const main = capture(() => openaiOk('好'));
    const events = await run(ctx, {
      primary: { provider: new OpenAIProvider({ apiKey: 'k', modelId: 'shared-model', baseUrl: EXAMPLE_APIS.vendorB, fetchImpl: main.fetchImpl }), input: VENDOR_B },
    });
    const sent = JSON.stringify(main.hits[0].body);
    expect(sent).toContain('[图片未发送：主力 不支持图片输入]');
    expect(sent).not.toContain('image_url');
    const notices = events.filter(e => e.kind === 'capability').flatMap(e => (e as { notices: string[] }).notices);
    expect(notices.some(n => n.includes('1 张图片改以文字占位'))).toBe(true);
    // 落库的仍是原始 mediaRef（只改请求侧副本）
    expect(ctx.store.listMessages(ctx.sessionId)[0].parts[1]).toMatchObject({ type: 'mediaRef' });
  });

  it('同一提示在工具循环的每一轮只说一次', async () => {
    const ctx = mkCtx();
    ctx.add('user', [{ type: 'text', value: '用工具' }]);
    let n = 0;
    const main = capture(() => n++ === 0
      ? sse([{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'T9', function: { name: 'echo', arguments: '{"text":"x","tool_title":"回声"}' } }] } }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }], true)
      : openaiOk('完成'));
    const events = await run(ctx, {
      primary: { provider: new OpenAIProvider({ apiKey: 'k', modelId: 'shared-model', baseUrl: EXAMPLE_APIS.vendorA, fetchImpl: main.fetchImpl }), input: VENDOR_A },
      thinkingLevel: 'medium',
    });
    expect(main.hits).toHaveLength(2);
    expect(main.hits.map(h => h.body.reasoning_effort)).toEqual(['low', 'low']);
    expect(events.filter(e => e.kind === 'capability')).toHaveLength(1);
  });
});

// ───────────────────────── F01R：独立复核确认问题的循环级回归 ─────────────────────────

const RELAY = 'https://relay.example/v1';
const TURN_END = { kind: 'turnEnd', stopReason: 'endTurn' };

/** 抓请求体的 fetch（应答可以看请求体与取消信号）。 */
function captureBody(respond: (body: Record<string, any>, n: number, init: { signal?: AbortSignal }) => Response | Promise<Response>) {
  const hits: { url: string; body: Record<string, any> }[] = [];
  const fetchImpl = (async (url: unknown, init?: { body?: unknown; signal?: AbortSignal }) => {
    const body = JSON.parse(String(init?.body)) as Record<string, any>;
    hits.push({ url: String(url), body });
    return respond(body, hits.length - 1, { signal: init?.signal });
  }) as unknown as FetchLike;
  return { hits, fetchImpl };
}
/** 假端点估算输入的口径：请求体 messages 的 JSON 长度 ÷ 4。 */
const inputTokensOf = (body: Record<string, any>): number => Math.ceil(JSON.stringify(body.messages ?? []).length / 4);
/** Kimi 式的超限报文：overflow.ts 认得，归为 contextOverflow。 */
const tokenLimit400 = (limit: number, requested: number): Response =>
  new Response(JSON.stringify({ error: { message: `Invalid request: Your request exceeded model token limit: ${limit} (requested: ${requested})` } }), { status: 400 });
const isSummaryRequest = (body: Record<string, any>): boolean =>
  body.messages?.[0]?.role === 'system' && body.messages[0].content === '你是对话摘要助手。';
const SUMMARY_TEXT = 'Summary: the user asked to read parts 1-3 of the build log; every part looked fine and no warnings were found.';
/** 按「输入 + max_tokens ≤ 窗口」校验的端点（Moonshot / vLLM 系的规则）。 */
const strict = (limit: number) => (body: Record<string, any>): Response => {
  const requested = Number(body.max_tokens ?? 0) + inputTokensOf(body);
  return requested > limit ? tokenLimit400(limit, requested) : openaiOk('ok');
};
/** 只在输入本身超过窗口时拒绝，不看 max_tokens——把「按哪个槽位判水位」与「max_tokens 取多少」两件事分开；
 *  摘要请求回一段能通过校验的摘要，其余请求由 reply 决定。 */
const overWindow = (limit: number, reply: () => Response = () => openaiOk('ok')) => (body: Record<string, any>): Response => {
  const input = inputTokensOf(body);
  if (input > limit) return tokenLimit400(limit, input);
  return isSummaryRequest(body) ? openaiOk(SUMMARY_TEXT) : reply();
};
const openaiToolCall = (id: string) => sse([
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, function: { name: 'echo', arguments: '{"text":"x","tool_title":"回声"}' } }] } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
], true);
const openai = (input: RuntimeModelInput, fetchImpl: FetchLike) =>
  new OpenAIProvider({ apiKey: 'k', modelId: input.modelId, baseUrl: input.baseUrl!, fetchImpl });
const noticesOf = (events: LoopEvent[]): string[] => events.flatMap(e => e.kind === 'capability' ? e.notices : []);
/** 事件序列的简写（失败时直接看得到走了哪条路）。 */
const kindsOf = (events: LoopEvent[]): string[] => events.map(e =>
  e.kind === 'fallback' ? `fallback:${e.cause ?? 'failure'}` : e.kind === 'error' ? `error:${e.code ?? e.message}` : e.kind);

/**
 * L4–L9 共用的历史：三条 110,000 字符的工具结果把历史推过 64,000 的窗口（假端点口径约 82.7K token），本轮带图。
 * 全用 ASCII：应用的估算（CJK ÷1.6、其余 ÷4）与假端点的口径（JSON 长度 ÷4）才是同一个数。
 * 真用户回合 6 个，压缩保留最近 3 个（回合 4–6）；回合 1–3 的工具结果在摘要取材时各截成头 1500 + 尾 500，一次摘完。
 */
function bigHistory(ctx: ReturnType<typeof mkCtx>): void {
  const output = 'build step ok; '.repeat(7_334).slice(0, 110_000);
  for (let n = 1; n <= 3; n++) {
    ctx.add('user', [{ type: 'text', value: `task ${n}: read part ${n} of the build log` }]);
    ctx.add('assistant', [{ type: 'toolUse', value: { toolUseId: `T${n}`, name: 'echo', input: `{"text":"part ${n}","tool_title":"read"}` } }]);
    ctx.add('user', [{ type: 'toolResult', value: { toolUseId: `T${n}`, output, success: true, status: 'success' } }]);
    ctx.add('assistant', [{ type: 'text', value: `part ${n} looks fine` }]);
  }
  ctx.add('user', [{ type: 'text', value: 'any warnings so far?' }]);
  ctx.add('assistant', [{ type: 'text', value: 'no warnings' }]);
  ctx.add('user', [{ type: 'text', value: 'ok, keep going' }]);
  ctx.add('assistant', [{ type: 'text', value: 'will do' }]);
  ctx.add('user', [{ type: 'text', value: 'look at this image' }, ctx.image('l4.png')]);
}

describe('F01R B1/A4：水位、压缩预算与摘要请求按接手这一轮的槽位算', () => {
  /** 主力窗口大、不收图；备用窗口小、收图。 */
  const BIG_NO_IMAGE: RuntimeModelInput = { ...VENDOR_B, contextWindow: 1_000_000 };
  const SMALL_IMAGE: RuntimeModelInput = { ...VENDOR_A, contextWindow: 64_000 };

  it('L4 主力窗口大不收图、备用窗口小收图、历史已超过备用窗口：先换到备用，再按备用的窗口压缩，本轮正常完成', async () => {
    const ctx = mkCtx();
    bigHistory(ctx);
    const before = ctx.store.listMessages(ctx.sessionId);
    // 前提：历史确实超过备用的 64000 窗口（以后有人把历史改小，这条用例就退化成只验「谁来压缩」）
    expect(before.reduce((n, m) => n + JSON.stringify(m.parts).length, 0) / 4).toBeGreaterThan(64_000);
    const main = captureBody(() => openaiOk('不该被请求'));
    const backup = captureBody(overWindow(64_000, () => openaiOk('seen')));
    const events = await run(ctx, {
      primary: { provider: openai(BIG_NO_IMAGE, main.fetchImpl), input: BIG_NO_IMAGE },
      fallback: [{ provider: openai(SMALL_IMAGE, backup.fetchImpl), input: SMALL_IMAGE }],
      context: true,
    });
    const kinds = kindsOf(events);
    expect(events.at(-1), `事件序列 ${kinds.join(' → ')}；主力 ${main.hits.length} 个请求；备用 ${backup.hits.length} 个请求，输入估算 ${backup.hits.map(h => inputTokensOf(h.body)).join(', ')}`)
      .toEqual(TURN_END);
    expect(main.hits).toHaveLength(0);
    // 备用先收到摘要请求（按它自己的窗口定预算：min(16384, 32000, 64000/4)），再收到正式请求
    expect(backup.hits).toHaveLength(2);
    expect(isSummaryRequest(backup.hits[0].body)).toBe(true);
    expect(backup.hits[0].body.max_tokens).toBe(16_000);
    expect('tools' in backup.hits[0].body).toBe(false);
    expect(kinds.filter(k => k === 'fallback:capability')).toHaveLength(1);
    expect(kinds.filter(k => k === 'compacted')).toHaveLength(1);
    expect(kinds.indexOf('fallback:capability')).toBeLessThan(kinds.indexOf('compacted'));
    expect(kinds).not.toContain('error:contextFull');
    const formal = backup.hits[1].body;
    expect(inputTokensOf(formal)).toBeLessThan(64_000);
    expect(JSON.stringify(formal.messages)).toContain('[对话摘要]');
    expect(JSON.stringify(formal.messages)).toContain('image_url');
    // 原始对话不因压缩改动：只多出本轮的回复
    const after = ctx.store.listMessages(ctx.sessionId);
    expect(after).toHaveLength(before.length + 1);
    expect(after.slice(0, before.length)).toEqual(before);
  });

  it('L5 反向（主力窗口小不收图、备用窗口大收图）：不按被跳过的主力的窗口压缩，主力一次请求都不收', async () => {
    const ctx = mkCtx();
    bigHistory(ctx);
    const mainIn: RuntimeModelInput = { ...VENDOR_B, contextWindow: 64_000 };
    const backupIn: RuntimeModelInput = { ...VENDOR_A, contextWindow: 1_000_000 };
    const main = captureBody(overWindow(64_000));
    const backup = captureBody(() => openaiOk('seen'));
    const events = await run(ctx, {
      primary: { provider: openai(mainIn, main.fetchImpl), input: mainIn },
      fallback: [{ provider: openai(backupIn, backup.fetchImpl), input: backupIn }],
      context: true,
    });
    expect(main.hits, `事件序列 ${kindsOf(events).join(' → ')}`).toHaveLength(0);
    expect(events.some(e => e.kind === 'compacted')).toBe(false);
    expect(backup.hits).toHaveLength(1);
    expect(events.at(-1)).toEqual(TURN_END);
  });

  it('L6 被跳过的主力是不输出文本的型号：摘要请求不发给它，本次运行的压缩也不会因此被停用', async () => {
    const ctx = mkCtx();
    bigHistory(ctx);
    // 对主力的 100000 窗口是 0.83（到压缩阈值）；对备用的 200000 窗口是 0.41（只到修剪档）
    const mainIn: RuntimeModelInput = { kind: 'openai-compat', baseUrl: RELAY, modelId: 'veo-x', contextWindow: 100_000 };
    const main = captureBody(() => new Response(JSON.stringify({ error: { message: 'this model does not support chat completions (mock)' } }), { status: 400 }));
    const backup = captureBody(() => openaiOk('seen'));
    const events = await run(ctx, {
      primary: { provider: openai(mainIn, main.fetchImpl), input: mainIn },
      fallback: [{ provider: openai(VENDOR_A, backup.fetchImpl), input: VENDOR_A }],
      context: true,
    });
    expect(main.hits, `事件序列 ${kindsOf(events).join(' → ')}`).toHaveLength(0);
    expect(events.some(e => e.kind === 'compactFailed')).toBe(false);
    expect(events.some(e => e.kind === 'compacted')).toBe(false);
    expect(backup.hits).toHaveLength(1);
    expect(events.at(-1)).toEqual(TURN_END);
  });

  it('L7 压缩后重入、工具循环的后续各轮：按能力切换只发生一次，同一句提示不重复', async () => {
    const ctx = mkCtx();
    bigHistory(ctx);
    const main = captureBody(() => openaiOk('不该被请求'));
    let formal = 0;
    const backup = captureBody(overWindow(64_000, () => formal++ === 0 ? openaiToolCall('T7') : openaiOk('done')));
    const events = await run(ctx, {
      primary: { provider: openai(BIG_NO_IMAGE, main.fetchImpl), input: BIG_NO_IMAGE },
      fallback: [{ provider: openai(SMALL_IMAGE, backup.fetchImpl), input: SMALL_IMAGE }],
      context: true,
    });
    expect(events.at(-1), `事件序列 ${kindsOf(events).join(' → ')}`).toEqual(TURN_END);
    expect(main.hits).toHaveLength(0);
    // 备用依次收到：摘要、正式请求（回工具调用）、工具结果之后的收尾
    expect(backup.hits).toHaveLength(3);
    expect(events.filter(e => e.kind === 'fallback')).toHaveLength(1);
    expect(events.filter(e => e.kind === 'fallback' && e.cause === 'capability')).toHaveLength(1);
    expect(events.filter(e => e.kind === 'compacted')).toHaveLength(1);
    const notices = noticesOf(events);
    expect(new Set(notices).size).toBe(notices.length);
  });

  it('L8 摘要请求进行中取消：报「已取消」，不写压缩记录，被跳过的主力仍一次请求都没有', async () => {
    const ctx = mkCtx();
    bigHistory(ctx);
    const abort = new AbortController();
    let arrived!: () => void;
    const summaryArrived = new Promise<void>(r => { arrived = r; });
    const main = captureBody(() => openaiOk('不该被请求'));
    const backup = captureBody((body, _n, init) => {
      if (!isSummaryRequest(body)) return overWindow(64_000)(body);
      arrived();
      // 受控延迟：摘要请求只在取消信号到达时结束，不靠 sleep 猜时序
      return new Promise<Response>((_resolve, reject) => {
        const fail = () => reject(new DOMException('aborted', 'AbortError'));
        if (init.signal?.aborted) fail(); else init.signal?.addEventListener('abort', fail, { once: true });
      });
    });
    const running = run(ctx, {
      primary: { provider: openai(BIG_NO_IMAGE, main.fetchImpl), input: BIG_NO_IMAGE },
      fallback: [{ provider: openai(SMALL_IMAGE, backup.fetchImpl), input: SMALL_IMAGE }],
      context: true, signal: abort.signal,
    });
    // 摘要请求到了备用才取消；摘要没发给备用（修复前）时等运行自己结束，由下面的断言报红，不会挂住
    await Promise.race([summaryArrived, running]);
    abort.abort();
    const events = await running;
    expect(events.at(-1), `事件序列 ${kindsOf(events).join(' → ')}`).toEqual({ kind: 'error', message: '已取消' });
    expect(ctx.store.getLatestCompactMarker(ctx.sessionId)).toBeUndefined();
    expect(main.hits).toHaveLength(0);
    expect(backup.hits).toHaveLength(1);
    expect(isSummaryRequest(backup.hits[0].body)).toBe(true);
  });

  it('L9 整条链都接不了、水位又到了压缩阈值：一次请求都不发（不先给接不了的主力发一条付费的摘要请求）', async () => {
    const ctx = mkCtx();
    bigHistory(ctx);
    const mainIn: RuntimeModelInput = { ...VENDOR_B, contextWindow: 64_000 };
    const main = captureBody(overWindow(64_000));
    const events = await run(ctx, { primary: { provider: openai(mainIn, main.fetchImpl), input: mainIn }, context: true });
    expect(main.hits, `事件序列 ${kindsOf(events).join(' → ')}`).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ kind: 'error', code: 'capability' });
    expect(events.some(e => e.kind === 'compacted')).toBe(false);
  });
});

describe('F01R A1 / A3 / A5 / C1 / D4：实际发出的请求体', () => {
  let excerpt: ModelCatalog;
  beforeEach(async () => {
    excerpt = new ModelCatalog(join(dir, 'excerpt.json'), async () => jsonResponse(snapshotExcerpt()));
    await excerpt.refresh(true);
  });

  it('L1 按「输入 + max_tokens ≤ 窗口」校验的端点不再首条消息即拒；降级到的备用同理（A1）', async () => {
    const KIMI: RuntimeModelInput = { kind: 'openai-compat', baseUrl: 'https://api.moonshot.cn/v1', modelId: 'kimi-k2.6' };
    const ctx = mkCtx();
    ctx.add('user', [{ type: 'text', value: '你好，在吗' }]);
    const main = captureBody(strict(262_144));
    const events = await run(ctx, { primary: { provider: openai(KIMI, main.fetchImpl), input: KIMI }, catalog: excerpt });
    expect(events.at(-1), `事件序列 ${kindsOf(events).join(' → ')}；max_tokens ${main.hits.map(h => h.body.max_tokens).join(', ')}`).toEqual(TURN_END);
    expect(main.hits).toHaveLength(1);
    expect(main.hits[0].body.max_tokens).toBe(65_536);

    const DEEPSEEK: RuntimeModelInput = { kind: 'openai-compat', baseUrl: 'https://api.siliconflow.cn/v1', modelId: 'deepseek-ai/DeepSeek-V3' };
    const ctx2 = mkCtx();
    ctx2.add('user', [{ type: 'text', value: '你好，在吗' }]);
    const limited = captureBody(() => rateLimited());
    const backup = captureBody(strict(164_000));
    const events2 = await run(ctx2, {
      primary: { provider: openai(KIMI, limited.fetchImpl), input: KIMI },
      fallback: [{ provider: openai(DEEPSEEK, backup.fetchImpl), input: DEEPSEEK }],
      catalog: excerpt,
    });
    expect(events2.at(-1), `事件序列 ${kindsOf(events2).join(' → ')}；备用 max_tokens ${backup.hits.map(h => h.body.max_tokens).join(', ')}`).toEqual(TURN_END);
    expect(backup.hits).toHaveLength(1);
    expect(backup.hits[0].body.max_tokens).toBe(8_192);
  });

  it('L2 降级到中转备用：不带未确认的推理参数并提示；手动标为支持后才带（A3）', async () => {
    const relayIn: RuntimeModelInput = { kind: 'openai-compat', baseUrl: RELAY, modelId: 'shared-model' };
    const once = async (backupIn: RuntimeModelInput) => {
      const ctx = mkCtx();
      ctx.add('user', [{ type: 'text', value: '想一想' }]);
      const main = captureBody(() => rateLimited());
      const backup = captureBody(() => openaiOk('想好了'));
      const events = await run(ctx, {
        primary: { provider: openai(VENDOR_B, main.fetchImpl), input: VENDOR_B },
        fallback: [{ provider: openai(backupIn, backup.fetchImpl), input: backupIn }],
        thinkingLevel: 'medium',
      });
      expect(events.at(-1)).toEqual(TURN_END);
      expect(main.hits).toHaveLength(1);
      expect(backup.hits).toHaveLength(1);
      return { body: backup.hits[0].body, events };
    };
    const plain = await once(relayIn);
    expect('reasoning_effort' in plain.body).toBe(false);
    const backupNotices = plain.events.flatMap(e => e.kind === 'capability' && e.label === '备用1' ? e.notices : []);
    expect(backupNotices.some(n => n.includes('未确认') && n.includes('手动修正'))).toBe(true);
    const marked = await once({ ...relayIn, capabilityOverrides: { reasoning: true } });
    expect(marked.body.reasoning_effort).toBe('medium');
  });

  it('L3 Anthropic 协议的中转、目录未收录的型号：不带 thinking（A3）', async () => {
    const input: RuntimeModelInput = { kind: 'anthropic', baseUrl: 'https://proxy.example', modelId: 'claude-not-in-catalog' };
    const ctx = mkCtx();
    ctx.add('user', [{ type: 'text', value: 'hi' }]);
    const main = captureBody(() => anthropicOk('ok'));
    const events = await run(ctx, {
      primary: { provider: new AnthropicProvider({ apiKey: 'k', modelId: input.modelId, baseUrl: input.baseUrl, fetchImpl: main.fetchImpl }), input },
      thinkingLevel: 'medium',
    });
    expect(events.at(-1)).toEqual(TURN_END);
    expect(main.hits).toHaveLength(1);
    expect('thinking' in main.hits[0].body).toBe(false);
    expect(main.hits[0].body.max_tokens).toBe(64_000);
  });

  it('L10 系统提示工厂拿得到「这个槽位这次带不带工具」（A5）', async () => {
    const seen: SystemPromptCtx[] = [];
    const factory = (c: SystemPromptCtx): string => { seen.push(c); return 'sys'; };
    for (const input of [VENDOR_B, VENDOR_A]) {
      const ctx = mkCtx();
      ctx.add('user', [{ type: 'text', value: 'hi' }]);
      const main = captureBody(() => openaiOk('ok'));
      const events = await run(ctx, { primary: { provider: openai(input, main.fetchImpl), input }, systemPrompt: factory });
      expect(events.at(-1)).toEqual(TURN_END);
      expect(main.hits[0].body.messages[0]).toEqual({ role: 'system', content: 'sys' });
    }
    expect(seen.map(c => c.sendTools)).toEqual([false, true]);
    expect(seen.map(c => c.modelId)).toEqual(['shared-model', 'shared-model']);
  });

  it('L11 只有一家否定的型号经中转：工具与图片照常发送，提示在工具循环里只说一次（C1/D2）', async () => {
    const f01r = new ModelCatalog(join(dir, 'f01r.json'), async () => jsonResponse(catalogFixtureF01R()));
    await f01r.refresh(true);
    const input: RuntimeModelInput = { kind: 'openai-compat', baseUrl: RELAY, modelId: 'solo-neg' };
    const ctx = mkCtx();
    ctx.add('user', [{ type: 'text', value: '看图并用工具' }, ctx.image('l11.png')]);
    let n = 0;
    const main = captureBody(() => n++ === 0 ? openaiToolCall('T11') : openaiOk('完成'));
    const events = await run(ctx, { primary: { provider: openai(input, main.fetchImpl), input }, catalog: f01r });
    expect(events.at(-1), `事件序列 ${kindsOf(events).join(' → ')}`).toEqual(TURN_END);
    expect(main.hits).toHaveLength(2);
    expect(main.hits.map(h => (h.body.tools ?? []).map((t: { function: { name: string } }) => t.function.name))).toEqual([['echo'], ['echo']]);
    expect(JSON.stringify(main.hits[0].body.messages)).toContain('image_url');
    expect(events.filter(e => e.kind === 'capability')).toHaveLength(1);
    expect(noticesOf(events).join('\n')).toMatch(/工具调用未确认[\s\S]*图片输入未确认/);
  });

  it('L12 官方 Gemini 上只声明档位的型号：请求体带回 F01 之前的推理预算（D4）', async () => {
    const input: RuntimeModelInput = { kind: 'gemini', modelId: 'gemini-flash-latest' };
    const ctx = mkCtx();
    ctx.add('user', [{ type: 'text', value: 'hi' }]);
    const main = captureBody(() => sse([
      { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } },
    ], false));
    const events = await run(ctx, {
      primary: { provider: new GeminiProvider({ apiKey: 'k', modelId: input.modelId, fetchImpl: main.fetchImpl }), input },
      thinkingLevel: 'medium', catalog: excerpt,
    });
    expect(events.at(-1)).toEqual(TURN_END);
    expect(main.hits).toHaveLength(1);
    expect(main.hits[0].body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 16_384, includeThoughts: true });
    expect(noticesOf(events).filter(n => n.includes('推理'))).toEqual([]);
  });
});
