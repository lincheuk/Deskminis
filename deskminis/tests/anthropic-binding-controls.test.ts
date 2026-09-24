/**
 * W2a-3 · 新一代 Claude 的思考块绑定（止血波设计稿 §2「新一代 Claude 缓解」、§3 第 1、3 条；
 * 侦察 engine.md「W2a-claudebinding」与 open_questions 第 3 条；cross.md S16）。
 *
 * 修前的样子：
 *  - claude-fable-5-1 / claude-mythos-5-1 / claude-opus-5-5 在带思考档位时照旧发 {type:'enabled', budget_tokens}，
 *    这三个模型对 enabled+budget_tokens 与 disabled 一律 400；
 *  - 官方端点不发 thinking-binding-controls 的 beta 头，也不写 block_binding：2026-08-31 之后注册的账号，
 *    系统提示每步重建、修剪滑窗、压缩保留回合都会让历史思考块的前缀校验失败，每次请求都 400；
 *  - 那条 400（「The block is bound to a different conversation」）被当成普通 400 判为可降级，loop 换组里下一个成员——
 *    换模型解决不了，还会把英文原文甩给用户。
 *
 * 本文件钉死：
 *  - 只有「https://api.anthropic.com × 三个精确 id」带 beta 头与 {type:'adaptive', block_binding:{prefix_mismatch_behavior:'drop_block'}}；
 *    三个 id 在任何端点、任何档位都不发 budget_tokens / disabled；第三方端点不带 block_binding（没有头时是 400「Extra inputs are not permitted」）；
 *  - 绑定 400 → ProviderError code='thinkingBinding'、不降级不重试，message 中文在前、原始错误在后（设计稿 §3 第 3 条）；
 *  - 未带 beta 头的请求遇到绑定 400：剥掉全部 thinking 与 redacted_thinking 块重试一次（官方 model-migration 的恢复法 1），
 *    仍失败才抛 thinkingBinding；
 *  - loop 拦截 thinkingBinding：不降级，直接报错。
 * 其它模型的请求体逐字节不变由 tests/provider-body-golden.test.ts 的 sha256 表钉住，这里只补「第三参对它们无效」。
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AnthropicProvider, buildAnthropicBody, isOfficialAnthropicEndpoint, anthropicBindingControls, mergeBetas, BINDING_MODELS,
} from '../src/minisd/providers/anthropic';
import { ProviderError, isFallbackable, isRetryable, type AgentProvider, type FetchLike, type StreamRequest } from '../src/minisd/providers/types';
import { isContextOverflowMessage } from '../src/minisd/providers/overflow';
import { runAgentLoop, type LoopEvent } from '../src/minisd/agent/loop';
import { openDb } from '../src/minisd/store/db';
import { ChatStore } from '../src/minisd/store/chat-store';
import { ToolRegistry } from '../src/minisd/tools/registry';
import type { ToolContext } from '../src/minisd/tools/types';
import { MinisPaths } from '../src/minisd/paths';
import type { AgentStreamEvent } from '../src/shared/types';

const TARGETS = ['claude-fable-5-1', 'claude-mythos-5-1', 'claude-opus-5-5'] as const;
const BETA = 'thinking-binding-controls-2026-08-01';
const DROP_BLOCK = { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } };
const RELAY = 'https://relay.example.com';
const LEAD = 'Claude 拒绝回放历史思考块';

/** 带思考历史的请求：一条带签名的 thinking、一条 redacted_thinking，外加 text / tool_use / tool_result。 */
const REQ: StreamRequest = {
  systemPrompt: '你是 DeskMinis',
  tools: [{ name: 'shell_execute', description: '执行命令', parameters: { command: { type: 'string', description: '命令' }, tool_title: { type: 'string', description: '摘要' } }, required: ['command', 'tool_title'] }],
  maxTokens: 8192, thinkingLevel: 'high',
  messages: [
    { role: 'user', parts: [{ type: 'text', value: '列出文件' }] },
    { role: 'assistant', parts: [
      { type: 'thinking', value: { text: '先列目录', signature: 'sig-1' } },
      { type: 'text', value: '我来列一下。' },
      { type: 'toolUse', value: { toolUseId: 'T1', name: 'shell_execute', input: '{"command":"dir","tool_title":"列目录"}' } },
    ] },
    { role: 'user', parts: [{ type: 'toolResult', value: { toolUseId: 'T1', output: 'a.txt', success: true, status: 'success' } }] },
    { role: 'assistant', parts: [
      { type: 'thinking', value: { text: '', redactedData: 'REDACTED-BLOB' } },
      { type: 'text', value: '只有 a.txt。' },
    ] },
    { role: 'user', parts: [{ type: 'text', value: '再看看 b 目录' }] },
  ],
};

/** 旧数据形态：末条 assistant 有 tool_use 没有 thinking（非目标模型在思考开启时会整请求关思考）。 */
const STALE_REQ: StreamRequest = {
  ...REQ, thinkingLevel: 'medium',
  messages: [
    { role: 'user', parts: [{ type: 'text', value: '列出文件' }] },
    { role: 'assistant', parts: [{ type: 'toolUse', value: { toolUseId: 'T1', name: 'shell_execute', input: '{"command":"dir","tool_title":"列目录"}' } }] },
    { role: 'user', parts: [{ type: 'toolResult', value: { toolUseId: 'T1', output: 'a.txt', success: true, status: 'success' } }] },
  ],
};

/** 没有可回放思考块的请求（剥了也一样，没必要重试）。 */
const PLAIN_REQ: StreamRequest = {
  ...REQ,
  messages: [
    { role: 'user', parts: [{ type: 'text', value: '你好' }] },
    { role: 'assistant', parts: [{ type: 'text', value: '你好！' }] },
    { role: 'user', parts: [{ type: 'text', value: '再说一遍' }] },
  ],
};

/** 官方文档给出的绑定 400 原文（未带 beta 头时末尾多一句要求加头）。 */
const BINDING_TEXT = 'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. '
  + 'Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to "drop_block". '
  + 'That setting requires the `thinking-binding-controls-2026-08-01` value in the `anthropic-beta` header.';
const bindingBody = (): string => JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: BINDING_TEXT }, request_id: 'req_w2a3' });
const binding400 = (): Response => new Response(bindingBody(), { status: 400, headers: { 'content-type': 'application/json' } });

const OK_SSE = [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join('');
const ok200 = (): Response => new Response(OK_SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } });

interface Captured { url: string; headers: Record<string, string>; body: string; signal: unknown }

/** 按顺序回放响应的 fetchImpl；请求头经 new Headers 归一化（实现换成 Headers 实例或换大小写也认得）。 */
function scriptedFetch(responses: (() => Response)[], out: Captured[]): FetchLike {
  return (async (input: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    if (init?.headers) for (const [k, v] of new Headers(init.headers as HeadersInit)) headers[k] = v;
    out.push({ url: String(input), headers, body: typeof init?.body === 'string' ? init.body : '', signal: init?.signal });
    const r = responses[out.length - 1];
    if (!r) throw new Error(`未预期的第 ${out.length} 次请求`);
    return r();
  }) as FetchLike;
}

async function drain(it: AsyncIterable<AgentStreamEvent>): Promise<AgentStreamEvent[]> {
  const out: AgentStreamEvent[] = []; for await (const e of it) out.push(e); return out;
}

async function send(modelId: string, baseUrl: string | undefined, req: StreamRequest, responses: (() => Response)[] = [ok200]) {
  const calls: Captured[] = [];
  const p = new AnthropicProvider({ apiKey: 'k', modelId, baseUrl, fetchImpl: scriptedFetch(responses, calls) });
  let error: unknown; let events: AgentStreamEvent[] = [];
  try { events = await drain(p.streamAgentMessage(req)); } catch (e) { error = e; }
  return { calls, events, error };
}

type Block = { type: string; [k: string]: unknown };
const blocksOf = (body: string): Block[] =>
  (JSON.parse(body) as { messages: { content: Block[] }[] }).messages.flatMap(m => m.content);
const THINKING_TYPES = ['thinking', 'redacted_thinking'];

// ── 判定：只认 https://api.anthropic.com × 三个精确 id ──

describe('W2a-3 判定：官方端点与三个目标模型都精确匹配', () => {
  it('isOfficialAnthropicEndpoint 解析 URL 后比对协议与主机名，不做子串匹配', () => {
    for (const u of ['https://api.anthropic.com', 'https://api.anthropic.com/', 'https://API.Anthropic.com', 'https://api.anthropic.com:443']) {
      expect(isOfficialAnthropicEndpoint(u), u).toBe(true);
    }
    for (const u of [
      'http://api.anthropic.com', // 明文
      'https://api.anthropic.com.relay.example.com', // 前缀相同的别家域名
      'https://relay.example.com/api.anthropic.com', // 路径里带官方域名
      'https://xapi.anthropic.com', // 后缀相同的别家主机
      'https://api.anthropic.com@evil.example.com', // userinfo 伪装
      RELAY, 'api.anthropic.com', '', 'not a url',
    ]) {
      expect(isOfficialAnthropicEndpoint(u), u).toBe(false);
    }
  });

  it('三个目标 id 精确命中；带日期后缀、别名、大小写不同、其它代际都不命中（维持旧行为）', () => {
    expect([...BINDING_MODELS].sort()).toEqual([...TARGETS].sort());
    for (const m of TARGETS) {
      expect(anthropicBindingControls('https://api.anthropic.com', m), m).toBe(true);
      expect(anthropicBindingControls(RELAY, m), `${m} @ relay`).toBe(false);
    }
    for (const m of ['claude-opus-5-5-20260901', 'claude-opus-5-5-latest', 'CLAUDE-OPUS-5-5', 'claude-opus-5', 'claude-fable-5', 'claude-sonnet-4-5', 'm']) {
      expect(anthropicBindingControls('https://api.anthropic.com', m), m).toBe(false);
    }
  });

  it('mergeBetas 按逗号合并去重、去空白', () => {
    expect(mergeBetas([BETA])).toBe(BETA);
    expect(mergeBetas(['a', 'b, a', ' c ', ''])).toBe('a,b,c');
  });
});

// ── ①②③ 官方端点：beta 头 + adaptive/drop_block，不发 budget_tokens ──

describe('W2a-3 ①②③ 官方端点上的三个模型：带 beta 头与 drop_block，从不发 budget_tokens', () => {
  for (const model of TARGETS) for (const baseUrl of [undefined, 'https://api.anthropic.com/']) for (const level of ['off', 'high'] as const) {
    it(`${model} · baseUrl=${String(baseUrl)} · thinkingLevel=${level}`, async () => {
      const { calls, error } = await send(model, baseUrl, { ...REQ, thinkingLevel: level });
      expect(error).toBeUndefined();
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages');
      expect(calls[0].headers['anthropic-beta']).toBe(BETA);
      const body = JSON.parse(calls[0].body) as Record<string, unknown>;
      expect(body.thinking).toEqual(DROP_BLOCK);
      expect(calls[0].body).not.toContain('budget_tokens');
      expect(calls[0].body).not.toContain('"disabled"');
      // 历史思考块照原样回放（drop_block 由服务端按需丢弃，客户端不动）
      expect(blocksOf(calls[0].body).filter(b => THINKING_TYPES.includes(b.type))).toHaveLength(2);
    });
  }

  it('旧数据形态（末条 tool_use 无 thinking）也不走「整请求关思考」：仍是 adaptive + drop_block', () => {
    const body = buildAnthropicBody(STALE_REQ, 'claude-opus-5-5', { bindingControls: true }) as Record<string, unknown>;
    expect(body.thinking).toEqual(DROP_BLOCK);
  });

  it('thinking 写在 system 之后（沿用原赋值位置），其余字段与非目标模型同形', () => {
    const body = buildAnthropicBody(REQ, 'claude-opus-5-5', { bindingControls: true });
    expect(Object.keys(body)).toEqual(['model', 'max_tokens', 'stream', 'messages', 'tools', 'system', 'thinking']);
  });
});

// ── ④ 第三方端点：不带头，不带 block_binding，也不发 budget_tokens ──

describe('W2a-3 ④ 第三方端点上的三个模型：不带头、不写 thinking（缺省即 adaptive）', () => {
  for (const model of TARGETS) {
    it(`${model} · ${RELAY} · thinkingLevel=high`, async () => {
      const { calls, error } = await send(model, RELAY, REQ);
      expect(error).toBeUndefined();
      expect(calls).toHaveLength(1);
      expect(Object.keys(calls[0].headers)).not.toContain('anthropic-beta');
      const body = JSON.parse(calls[0].body) as Record<string, unknown>;
      expect(body.thinking).toBeUndefined();
      expect(calls[0].body).not.toContain('block_binding');
      expect(calls[0].body).not.toContain('budget_tokens');
    });
  }

  it('buildAnthropicBody 两参调用（不开绑定控制）同样不发 budget_tokens', () => {
    for (const model of TARGETS) {
      const body = buildAnthropicBody(REQ, model) as Record<string, unknown>;
      expect(body.thinking, model).toBeUndefined();
    }
  });
});

// ── ⑤ 非目标模型：第三参无效，请求头不变（逐字节由黄金表钉） ──

describe('W2a-3 ⑤ 非目标模型走原分支，一字不动', () => {
  const others = ['claude-sonnet-4-5', 'claude-opus-5', 'm', 'claude-opus-5-5-20260901'];
  it('bindingControls:true 对非目标模型不起作用：JSON 与两参调用逐字节相同', () => {
    for (const m of others) for (const req of [REQ, STALE_REQ, PLAIN_REQ, { ...REQ, thinkingLevel: 'off' as const }]) {
      expect(JSON.stringify(buildAnthropicBody(req, m, { bindingControls: true })), m).toBe(JSON.stringify(buildAnthropicBody(req, m)));
    }
  });

  it('带日期后缀的 id 在官方端点也不带 beta 头，仍按旧规则发 enabled + budget_tokens', async () => {
    const { calls } = await send('claude-opus-5-5-20260901', undefined, REQ);
    expect(calls[0].headers).toEqual({ 'content-type': 'application/json', 'x-api-key': 'k', 'anthropic-version': '2023-06-01' });
    expect((JSON.parse(calls[0].body) as { thinking: unknown }).thinking).toEqual({ type: 'enabled', budget_tokens: 8191 });
  });
});

// ── ⑥ 绑定 400 的分类 ──

describe('W2a-3 ⑥ 绑定 400 → thinkingBinding：不降级不重试，中文在前、原文在后', () => {
  it('官方端点（带 beta 头）：只发一次，抛 thinkingBinding', async () => {
    const { calls, error } = await send('claude-opus-5-5', undefined, REQ, [binding400]);
    expect(calls).toHaveLength(1);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code: 'thinkingBinding', fallbackable: false, retryable: false, status: 400 });
    const msg = (error as ProviderError).message;
    expect(msg.startsWith(LEAD)).toBe(true);
    expect(msg).toContain('新建会话');
    expect(msg).toContain('bound to a different conversation');
    expect(msg.indexOf(LEAD)).toBeLessThan(msg.indexOf('Anthropic HTTP 400'));
  });

  it('回归：普通 400 仍按老规则判为可降级，不带 code、不重试', async () => {
    const { calls, error } = await send('claude-opus-5-5', RELAY, REQ, [() => new Response('{"error":{"message":"invalid model"}}', { status: 400 })]);
    expect(calls).toHaveLength(1);
    expect(error).toMatchObject({ status: 400, fallbackable: true });
    expect((error as ProviderError).code).toBeUndefined();
  });

  it('按报文推导：OpenAI 兼容中转转发的同类错误也归 thinkingBinding，message 同样中文在前', () => {
    const raw = `OpenAI HTTP 400: ${bindingBody()}`;
    const e = new ProviderError(raw, { status: 400 });
    expect(e.code).toBe('thinkingBinding');
    expect(isFallbackable(e)).toBe(false);
    expect(isRetryable(e)).toBe(false);
    expect(e.message.startsWith(LEAD)).toBe(true);
    expect(e.message).toContain(raw);
    // 已经包好的 message 再构造一次不会叠两层中文
    expect(new ProviderError(e.message, { status: 400 }).message).toBe(e.message);
    // 绑定报文不会被误认成超窗
    expect(isContextOverflowMessage(raw, 400)).toBe(false);
  });

  it('按报文推导带状态闸：429 与 5xx 即使含同样字样也不算绑定错误，老规则不变', () => {
    const r429 = new ProviderError(`Anthropic HTTP 429: ${bindingBody()}`, { status: 429 });
    expect(r429.code).toBeUndefined();
    expect(isFallbackable(r429)).toBe(true);
    const r500 = new ProviderError(`Anthropic HTTP 500: ${bindingBody()}`, { status: 500 });
    expect(r500.code).toBeUndefined();
    expect(isRetryable(r500)).toBe(true);
  });
});

// ── open_questions 3：未带 beta 头的请求剥思考重试一次 ──

describe('W2a-3 第三方端点（未带 beta 头）遇绑定 400：剥掉全部思考块重试一次', () => {
  it('第二次请求不含任何 thinking / redacted_thinking，text 与 tool_use 原样保留；成功则照常出流', async () => {
    const calls: Captured[] = [];
    const ctl = new AbortController();
    const p = new AnthropicProvider({ apiKey: 'k', modelId: 'claude-opus-5-5', baseUrl: RELAY, fetchImpl: scriptedFetch([binding400, ok200], calls) });
    const events = await drain(p.streamAgentMessage(REQ, ctl.signal));
    expect(calls).toHaveLength(2);
    for (const c of calls) expect(Object.keys(c.headers)).not.toContain('anthropic-beta');
    // 两次请求都带着调用方的取消信号
    expect(calls[0].signal).toBe(ctl.signal);
    expect(calls[1].signal).toBe(ctl.signal);
    const first = blocksOf(calls[0].body); const second = blocksOf(calls[1].body);
    expect(first.filter(b => b.type === 'thinking')).toHaveLength(1);
    expect(first.filter(b => b.type === 'redacted_thinking')).toHaveLength(1);
    expect(second.filter(b => THINKING_TYPES.includes(b.type))).toEqual([]);
    expect(second).toEqual(first.filter(b => !THINKING_TYPES.includes(b.type)));
    expect(calls[1].body).not.toContain('block_binding');
    expect(calls[1].body).not.toContain('budget_tokens');
    expect(events).toContainEqual({ kind: 'textDelta', text: 'ok' });
    expect(events.at(-1)).toEqual({ kind: 'done', stopReason: 'endTurn' });
  });

  it('不限模型：非目标模型在第三方端点上同样剥思考重试（请求体随之按旧规则重建）', async () => {
    const { calls, error } = await send('claude-sonnet-4-5', RELAY, REQ, [binding400, ok200]);
    expect(error).toBeUndefined();
    expect(calls).toHaveLength(2);
    expect(blocksOf(calls[1].body).filter(b => THINKING_TYPES.includes(b.type))).toEqual([]);
    expect(calls[1].body).toBe(JSON.stringify(buildAnthropicBody({
      ...REQ, messages: REQ.messages.map(m => ({ ...m, parts: m.parts.filter(pt => pt.type !== 'thinking') })),
    }, 'claude-sonnet-4-5')));
  });

  it('每个请求最多重试一次：第二次仍是绑定 400 就抛 thinkingBinding，不再发第三次', async () => {
    const { calls, error } = await send('claude-opus-5-5', RELAY, REQ, [binding400, binding400]);
    expect(calls).toHaveLength(2);
    expect(error).toMatchObject({ code: 'thinkingBinding', fallbackable: false, retryable: false });
    expect((error as ProviderError).message.startsWith(LEAD)).toBe(true);
  });

  it('请求里没有可回放的思考块：剥了也是同一个请求体，不重试，直接 thinkingBinding', async () => {
    const { calls, error } = await send('claude-opus-5-5', RELAY, PLAIN_REQ, [binding400]);
    expect(calls).toHaveLength(1);
    expect(error).toMatchObject({ code: 'thinkingBinding' });
  });

  it('重试遇到别的错误就按那条错误的状态分类（例如 429 仍可降级），不硬套 thinkingBinding', async () => {
    const { calls, error } = await send('claude-opus-5-5', RELAY, REQ, [binding400, () => new Response('rate limited', { status: 429 })]);
    expect(calls).toHaveLength(2);
    expect(error).toMatchObject({ status: 429, fallbackable: true });
    expect((error as ProviderError).code).toBeUndefined();
  });
});

// ── ⑦ loop：thinkingBinding 不降级 ──

function mkCtx(): { store: ChatStore; tools: ToolRegistry; toolContext: ToolContext; sessionId: string } {
  const store = new ChatStore(openDb(':memory:'));
  const s = store.createSession();
  const root = mkdtempSync(join(tmpdir(), 'dm-binding-'));
  const paths = new MinisPaths(root); paths.ensureSessionDirs(s.id);
  const toolContext: ToolContext = { sessionId: s.id, paths, permissions: { async check() { return 'allow'; }, hasBridgeGrant: () => false } };
  return { store, tools: new ToolRegistry(), toolContext, sessionId: s.id };
}

let tick = 0;
function seedHistory(store: ChatStore, sessionId: string): void {
  const at = (): number => store.nowEpoch() + (++tick) * 0.001;
  store.appendMessage({ id: 'U0', sessionId, role: 'user', parts: [{ type: 'text', value: '列出文件' }], createdAt: at(), streamInterruptCount: 0 });
  store.appendMessage({ id: 'A0', sessionId, role: 'assistant', parts: [
    { type: 'thinking', value: { text: '先想想', signature: 'sig-old' } },
    { type: 'text', value: '只有 a.txt。' },
  ], createdAt: at(), streamInterruptCount: 0 });
  store.appendMessage({ id: 'U1', sessionId, role: 'user', parts: [{ type: 'text', value: '再看看 b 目录' }], createdAt: at(), streamInterruptCount: 0 });
}

class Backup implements AgentProvider {
  readonly name = 'scripted'; readonly modelId = 'backup'; calls = 0;
  async *streamAgentMessage(): AsyncIterable<AgentStreamEvent> {
    this.calls++;
    yield { kind: 'textDelta', text: '不该走到' }; yield { kind: 'done', stopReason: 'endTurn' };
  }
}

async function runWith(modelId: string, baseUrl: string | undefined, responses: (() => Response)[]) {
  const { store, tools, toolContext, sessionId } = mkCtx();
  seedHistory(store, sessionId);
  const calls: Captured[] = [];
  const main = new AnthropicProvider({ apiKey: 'k', modelId, baseUrl, fetchImpl: scriptedFetch(responses, calls) });
  const backup = new Backup();
  const events: LoopEvent[] = [];
  for await (const e of runAgentLoop(store, {
    sessionId, provider: main, tools, toolContext, systemPrompt: 'sys', retryDelaysMs: [0],
    primaryLabel: 'main', fallbackChain: [{ provider: backup, label: 'backup' }],
  })) events.push(e);
  return { events, calls, backup };
}

describe('W2a-3 ⑦ loop：绑定错误不降级，直接报中文错误', () => {
  it('官方端点：没有 fallback 事件、backup 一次没请求，以 thinkingBinding 收场，文案指向新建会话', async () => {
    const { events, calls, backup } = await runWith('claude-opus-5-5', undefined, [binding400]);
    expect(events.some(e => e.kind === 'fallback')).toBe(false);
    expect(backup.calls).toBe(0);
    expect(calls).toHaveLength(1);
    const last = events.at(-1) as { kind: string; code?: string; message: string };
    expect(last).toMatchObject({ kind: 'error', code: 'thinkingBinding' });
    expect(last.message.startsWith(LEAD)).toBe(true);
    expect(last.message).toContain('新建会话');
  });

  it('第三方端点：先剥思考重试一次，仍失败才报 thinkingBinding，同样不降级', async () => {
    const { events, calls, backup } = await runWith('claude-opus-5-5', RELAY, [binding400, binding400]);
    expect(calls).toHaveLength(2);
    expect(backup.calls).toBe(0);
    expect(events.some(e => e.kind === 'fallback')).toBe(false);
    expect(events.at(-1)).toMatchObject({ kind: 'error', code: 'thinkingBinding' });
  });

  it('第三方端点：剥思考重试成功，本回合照常结束，不报错也不降级', async () => {
    const { events, calls, backup } = await runWith('claude-opus-5-5', RELAY, [binding400, ok200]);
    expect(calls).toHaveLength(2);
    expect(backup.calls).toBe(0);
    expect(events.some(e => e.kind === 'fallback' || e.kind === 'error')).toBe(false);
    expect(events.at(-1)).toEqual({ kind: 'turnEnd', stopReason: 'endTurn' });
  });
});
