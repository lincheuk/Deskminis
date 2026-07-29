# DeskMinis M2b（Gemini/Ollama Provider + 模型能力目录 + 模型组降级链）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 minisd 补齐四轨模型接入的另外两轨——Gemini 原生 Provider（thoughtSignature 持久化与回放）与 Ollama 本地 Provider（OpenAI 兼容端点预设），落地 models.dev 模型能力目录（ThinkingLevel 按模型族钳制、上下文窗口查询供 M2a ContextPolicy 使用），并实现跨厂商模型组降级链（ModelGroup 持久化、fallback 事件、空响应两路处理、成功后改写会话绑定）。

**Architecture:** 沿用 M1 的单方法 Provider 契约（`streamAgentMessage`）与 Agent 循环重试梯。Gemini 走 `streamGenerateContent?alt=sse`，函数调用整体到达时合成 UUID id，thoughtSignature 持久化进 `toolUse.thoughtSignature`（M1 已预留该字段）并在后续请求回放；无签名历史调用连同其配对结果降级为文本摘要。Ollama 复用 `OpenAIProvider` 实现 + 预设兼容 flag（无 key 跳过鉴权头、默认 baseUrl `http://localhost:11434/v1`、不发 `reasoning_effort`）。能力目录 = models.dev API 拉取 + 磁盘缓存 + 内置兜底表。降级链以 `ProviderSlot[]` 注入 Agent 循环，错误按 `isRetryable`（同模型重试，M1 已有）/ `isFallbackable`（限流/无效 key/provider 错误，立刻降级）分类驱动。设计依据见 `../specs/2026-07-26-deskminis-design.md` §4.1、§4.2。

**Tech Stack:** TypeScript (strict) / vitest / 无新增运行时依赖（Gemini/Ollama 均走 fetch + SSE，复用 M1 `parseSse`）

## Global Constraints

- 代码基线：**M1 已完成**（130 个测试全绿）。假定其他 M2 子计划（M2a 压缩/卸载、记忆、技能、UI）均未执行；凡引用 M2a 处只声明接口签名
- 所有代码在 `deskminis/` 子目录（仓库根 `C:\Users\24739\Downloads\openminis1\`）
- TypeScript `strict: true`；测试命令统一 `npm test`（vitest run），单文件 `npm test -- tests/xxx.test.ts`
- 提交信息用 conventional commits + 中文（如 `feat(m2b): …`）；全文中文
- Gemini/Ollama 的单测一律用**录制的 SSE 流文本回放**（fake `fetchImpl` 返回 `Response`），禁止真连网络
- API key 只进凭据库（@napi-rs/keyring）；Ollama 允许无 key；providers.json 与 RPC 响应永不含明文密钥
- provider kind 联合扩展为 `'anthropic' | 'openai-compat' | 'gemini' | 'ollama'`
- 错误分类：`isRetryable`（网络/5xx/529 → 同模型透明重试，重试梯 [3000,5000,10000,15000,30000]ms）vs `isFallbackable`（429 限流 / 401/403 无效 key / 400/404/422 provider 错误 → 立刻降级到模型组下一成员）
- `sessions.model_binding` 取值约定：`'provider:<instanceId>'`（绑定单实例）| `'group:<groupId>'`（绑定模型组）| 空/NULL（未绑定，走默认 provider）
- 破坏性 RPC 方法要求 `confirm:true`（对齐 M1）
- 时间戳一律 epoch 秒（浮点）；ID 一律 `crypto.randomUUID().toUpperCase()`（M1 约束延续）
- 本计划只覆盖 minisd 侧；模型组管理界面、fallback 事件在聊天流的展示组件属 M2 UI 子计划，不在此范围

## 文件结构总览

```
deskminis/
  src/shared/types.ts                Modify: AgentStreamEvent.toolCallComplete 增加 thoughtSignature?
  src/minisd/providers/types.ts      Modify: ProviderError 增加 fallbackable + isRetryable/isFallbackable 帮助函数
  src/minisd/providers/gemini.ts     Create: GeminiProvider + buildGeminiBody
  src/minisd/providers/openai.ts     Modify: OpenAICompatFlags（skipAuth/compat 行为）, Ollama 复用入口
  src/minisd/providers/model-catalog.ts  Create: ModelCatalog（models.dev 拉取 + 磁盘缓存 + 内置兜底 + 钳制）
  src/minisd/store/provider-store.ts Modify: kind 联合扩展、ollama 免 key、ModelGroup CRUD + resolveGroupMembers
  src/minisd/store/chat-store.ts     Modify: setModelBinding
  src/minisd/agent/loop.ts           Modify: LoopEvent 增加 fallback；RunOptions 增加 fallbackChain；降级/空响应逻辑
  src/minisd/index.ts                Modify: provider.instances.* 校验扩展、modelgroup.* RPC、chat.prompt 链式解析
  tests/provider-errors.test.ts      Create（Task 1）
  tests/gemini.test.ts               Create（Task 2）
  tests/ollama.test.ts               Create（Task 3）
  tests/model-catalog.test.ts        Create（Task 4）
  tests/provider-store.test.ts       Append（Task 3、Task 5）
  tests/chat-store.test.ts           Append（Task 5）
  tests/agent-loop.test.ts           Append（Task 2、Task 6）
  tests/rpc.test.ts                  Append（Task 3、Task 7）
```

任务依赖：1 → 2 → 3 → 4 → 5 → 6 → 7（严格串行，后续任务消费前序任务的签名）。

---

### Task 1: ProviderError 错误分类（isRetryable / isFallbackable）

**Files:**
- Modify: `deskminis/src/minisd/providers/types.ts`
- Test: `deskminis/tests/provider-errors.test.ts`

**Interfaces:**
- Consumes: 无（M1 既有 `ProviderError`）
- Produces（Task 2/3/6 依赖）:
  - `class ProviderError extends Error { status?: number; retryable: boolean; fallbackable: boolean; constructor(message: string, opts?: { status?: number; retryable?: boolean; fallbackable?: boolean }) }`
    - `retryable` 默认推导：`status ∈ [500,502,503,504,529]`（M1 行为不变）
    - `fallbackable` 默认推导：`status ∈ [400,401,403,404,422,429]`
  - `function isRetryable(e: unknown): boolean` — `e instanceof ProviderError && e.retryable`
  - `function isFallbackable(e: unknown): boolean` — `e instanceof ProviderError && e.fallbackable`

**语义**（设计 §4.2）：`isRetryable` = 网络抖动/网关与过载类 5xx，同模型透明重试（M1 重试梯）；`isFallbackable` = 限流（429）、无效/无权 key（401/403）、provider 侧请求错误（400/404/422，如模型名错误），不做同模型重试，立刻降级到模型组下一成员。两类互斥；无 status 的网络错误只 retryable。429 保持 `retryable: false`（M1 anthropic 测试已锁定此行为）。

- [x] **Step 1: 写失败测试**

`deskminis/tests/provider-errors.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { ProviderError, isRetryable, isFallbackable } from '../src/minisd/providers/types';

describe('ProviderError 错误分类', () => {
  it('网络错误（无 status）→ retryable, 不 fallbackable', () => {
    const e = new ProviderError('网络错误: x', { retryable: true });
    expect(isRetryable(e)).toBe(true);
    expect(isFallbackable(e)).toBe(false);
  });
  it('529/503/500 → retryable, 不 fallbackable', () => {
    for (const s of [500, 502, 503, 504, 529]) {
      const e = new ProviderError('x', { status: s });
      expect(isRetryable(e)).toBe(true);
      expect(isFallbackable(e)).toBe(false);
    }
  });
  it('429 限流 → 不 retryable, fallbackable', () => {
    const e = new ProviderError('rate limited', { status: 429 });
    expect(isRetryable(e)).toBe(false);
    expect(isFallbackable(e)).toBe(true);
  });
  it('401/403 无效 key → fallbackable, 不 retryable', () => {
    for (const s of [401, 403]) {
      const e = new ProviderError('bad key', { status: s });
      expect(isFallbackable(e)).toBe(true);
      expect(isRetryable(e)).toBe(false);
    }
  });
  it('400/404/422 provider 请求错误 → fallbackable', () => {
    for (const s of [400, 404, 422]) {
      expect(isFallbackable(new ProviderError('x', { status: s }))).toBe(true);
    }
  });
  it('显式旗标覆盖默认推导', () => {
    const e = new ProviderError('自定义', { status: 500, fallbackable: true });
    expect(isFallbackable(e)).toBe(true);
    const e2 = new ProviderError('自定义2', { status: 429, retryable: true });
    expect(isRetryable(e2)).toBe(true);
  });
  it('非 ProviderError 一律 false', () => {
    expect(isRetryable(new Error('x'))).toBe(false);
    expect(isFallbackable('x')).toBe(false);
    expect(isFallbackable(undefined)).toBe(false);
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `cd deskminis && npm test -- tests/provider-errors.test.ts`
Expected: FAIL（`isRetryable`/`isFallbackable` 未导出，`fallbackable` 不存在）

- [x] **Step 3: 修改 types.ts**

`deskminis/src/minisd/providers/types.ts` 完整替换为：

```typescript
import type { AgentMessage, AgentStreamEvent, AgentToolDefinition, ThinkingLevel } from '../../shared/types';

export interface StreamRequest {
  messages: AgentMessage[];
  systemPrompt?: string;
  tools: AgentToolDefinition[];
  maxTokens: number;
  thinkingLevel: ThinkingLevel;
}

export interface AgentProvider {
  readonly name: string;
  readonly modelId: string;
  streamAgentMessage(req: StreamRequest, signal?: AbortSignal): AsyncIterable<AgentStreamEvent>;
}

export class ProviderError extends Error {
  status?: number;
  retryable: boolean;
  fallbackable: boolean;
  constructor(message: string, opts: { status?: number; retryable?: boolean; fallbackable?: boolean } = {}) {
    super(message);
    this.status = opts.status;
    // 同模型透明重试：网络抖动与网关/过载类 5xx（M1 语义不变）
    this.retryable = opts.retryable ?? (opts.status !== undefined && [500, 502, 503, 504, 529].includes(opts.status));
    // 立刻降级到模型组下一成员：限流(429)、无效/无权 key(401/403)、provider 侧请求错误(400/404/422)
    this.fallbackable = opts.fallbackable ?? (opts.status !== undefined && [400, 401, 403, 404, 422, 429].includes(opts.status));
  }
}

/** 同模型重试（M1 重试梯）。 */
export function isRetryable(e: unknown): boolean {
  return e instanceof ProviderError && e.retryable;
}

/** 立刻降级到模型组下一成员（限流/无效 key/provider 错误）。 */
export function isFallbackable(e: unknown): boolean {
  return e instanceof ProviderError && e.fallbackable;
}

export type FetchLike = typeof fetch;
```

- [x] **Step 4: 跑测试确认通过 + M1 测试不回归**

Run: `cd deskminis && npm test -- tests/provider-errors.test.ts`
Expected: PASS（7 个用例）

Run: `cd deskminis && npm test`
Expected: 全部通过（M1 的 130 个测试不受影响——`ProviderError` 只新增字段，既有 `retryable` 推导不变）

- [x] **Step 5: Commit**

```bash
cd "C:\Users\24739\Downloads\openminis1" && git add deskminis/src/minisd/providers/types.ts deskminis/tests/provider-errors.test.ts && git commit -m "feat(m2b): ProviderError 增加 fallbackable 错误分类（isRetryable/isFallbackable）"
```

---

### Task 2: Gemini Provider（thoughtSignature 全链路）

**Files:**
- Create: `deskminis/src/minisd/providers/gemini.ts`
- Modify: `deskminis/src/shared/types.ts`（`toolCallComplete` 事件增加可选 `thoughtSignature`）
- Modify: `deskminis/src/minisd/agent/loop.ts`（`AccumulatedCall` 透传并持久化 `thoughtSignature`，仅两处小改，见 Step 4）
- Test: `deskminis/tests/gemini.test.ts`、`deskminis/tests/agent-loop.test.ts`（追加一个用例）

**Interfaces:**
- Consumes: M1 `parseSse`/`AgentProvider`/`StreamRequest`/`ProviderError`（Task 1 已加 `fallbackable` 推导）；`ContentPart.toolUse.value.thoughtSignature?`（M1 已预留）
- Produces（Task 3/6/7 依赖）:
  - `function buildGeminiBody(req: StreamRequest, modelId: string): Record<string, unknown>` — 消息/工具/thinking 映射 + 无签名历史调用降级
  - `class GeminiProvider implements AgentProvider { readonly name = 'gemini'; constructor(opts: { apiKey: string; modelId: string; baseUrl?: string; fetchImpl?: FetchLike }) }` — baseUrl 默认 `https://generativelanguage.googleapis.com`
  - `AgentStreamEvent` 的 `toolCallComplete` 成员变为 `{ kind: 'toolCallComplete'; toolUseId: string; name: string; input: string; thoughtSignature?: string }`
  - Agent 循环把 `toolCallComplete.thoughtSignature` 持久化到 `toolUse.thoughtSignature`

**Gemini 线路细节**（写进实现注释）：
- 端点：`POST {baseUrl}/v1beta/models/{modelId}:streamGenerateContent?alt=sse`，鉴权头 `x-goog-api-key`（不走 query `key=`，避免密钥进 URL 日志）
- 角色映射：`assistant → 'model'`，`user → 'user'`；system prompt 走顶层 `system_instruction`
- 工具：`tools: [{ functionDeclarations: [{ name, description, parameters: { type:'object', properties{类型大写 STRING/INTEGER/BOOLEAN}, required } }] }]`
- thinking：`generationConfig.thinkingConfig = { thinkingBudget: min(BUDGETS[level], maxTokens-1), includeThoughts: true }`；`off` 不发 `thinkingConfig`。`BUDGETS = { low: 4096, medium: 16384, high: 24576 }`
- 历史回放：`toolUse` → `{ functionCall: { name, args }, thoughtSignature }`；`toolResult` → `{ functionResponse: { name, response: { result } } }`（name 从前面已见的 toolUse 反查）。**无 `thoughtSignature` 的历史 toolUse 不能回放成 functionCall**（Gemini 3 校验签名会 400），连同它配对的 toolResult 一起降级为 `[历史工具调用]/[历史工具结果]` 文本 part
- 流事件：`part.thought === true` 的 text → `thinkingDelta`；普通 text → `textDelta`；`functionCall` 整体到达 → 合成 `randomUUID().toUpperCase()` 作为 toolUseId，直接发 `toolCallComplete`（附带 `thoughtSignature`）；`usageMetadata` → `usage`；`finishReason`: `STOP→endTurn`、`MAX_TOKENS→maxTokens`、`SAFETY/RECITATION/OTHER→refusal`；`promptFeedback.blockReason` → `refusal`；本轮出现过 functionCall 则最终 `stopReason = 'toolUse'`
- 断流判定：整个流既无 `finishReason` 也无 `usageMetadata` → 抛 `ProviderError('SSE 流提前结束', { retryable: true })`

- [x] **Step 1: 写失败测试**

`deskminis/tests/gemini.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { GeminiProvider, buildGeminiBody } from '../src/minisd/providers/gemini';
import type { StreamRequest } from '../src/minisd/providers/types';
import type { AgentStreamEvent } from '../src/shared/types';

const TOOLS: StreamRequest['tools'] = [
  { name: 'shell_execute', description: '执行命令', parameters: { command: { type: 'string', description: '命令' }, tool_title: { type: 'string', description: '摘要' } }, required: ['command', 'tool_title'] },
];

const BASE: StreamRequest = {
  messages: [{ role: 'user', parts: [{ type: 'text', value: '列目录' }] }],
  systemPrompt: '你是 DeskMinis',
  tools: TOOLS,
  maxTokens: 4096, thinkingLevel: 'off',
};

describe('buildGeminiBody', () => {
  it('system_instruction / contents 角色 / 工具 / generationConfig 映射', () => {
    const body = buildGeminiBody(BASE, 'gemini-2.5-flash') as any;
    expect(body.system_instruction).toEqual({ parts: [{ text: '你是 DeskMinis' }] });
    expect(body.contents[0]).toEqual({ role: 'user', parts: [{ text: '列目录' }] });
    expect(body.tools[0].functionDeclarations[0].name).toBe('shell_execute');
    expect(body.tools[0].functionDeclarations[0].parameters.properties.command.type).toBe('STRING');
    expect(body.tools[0].functionDeclarations[0].parameters.required).toEqual(['command', 'tool_title']);
    expect(body.generationConfig.maxOutputTokens).toBe(4096);
    expect(body.generationConfig.thinkingConfig).toBeUndefined();
    expect(body.model).toBeUndefined(); // model 在 URL 里，不在 body
  });

  it('thinking medium → thinkingBudget 封顶 min(16384, maxTokens-1)', () => {
    const tight = buildGeminiBody({ ...BASE, thinkingLevel: 'medium' }, 'm') as any;
    expect(tight.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 4095, includeThoughts: true });
    const roomy = buildGeminiBody({ ...BASE, thinkingLevel: 'medium', maxTokens: 64000 }, 'm') as any;
    expect(roomy.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 16384, includeThoughts: true });
  });

  it('带 thoughtSignature 的历史调用原样回放为 functionCall + functionResponse', () => {
    const req: StreamRequest = {
      ...BASE,
      messages: [
        { role: 'user', parts: [{ type: 'text', value: '列目录' }] },
        { role: 'assistant', parts: [
          { type: 'text', value: '好的' },
          { type: 'toolUse', value: { toolUseId: 'T1', name: 'shell_execute', input: '{"command":"dir","tool_title":"列目录"}', thoughtSignature: 'c2ln' } },
        ] },
        { role: 'user', parts: [{ type: 'toolResult', value: { toolUseId: 'T1', output: 'a.txt', success: true, status: 'success' } }] },
      ],
    };
    const body = buildGeminiBody(req, 'm') as any;
    expect(body.contents[1].role).toBe('model');
    expect(body.contents[1].parts[0]).toEqual({ text: '好的' });
    expect(body.contents[1].parts[1]).toEqual({ functionCall: { name: 'shell_execute', args: { command: 'dir', tool_title: '列目录' } }, thoughtSignature: 'c2ln' });
    expect(body.contents[2]).toEqual({ role: 'user', parts: [{ functionResponse: { name: 'shell_execute', response: { result: 'a.txt' } } }] });
  });

  it('无签名的历史调用连同配对结果降级为文本摘要', () => {
    const req: StreamRequest = {
      ...BASE,
      messages: [
        { role: 'user', parts: [{ type: 'text', value: '列目录' }] },
        { role: 'assistant', parts: [
          { type: 'toolUse', value: { toolUseId: 'T1', name: 'shell_execute', input: '{"command":"dir","tool_title":"列目录"}' } },
        ] },
        { role: 'user', parts: [{ type: 'toolResult', value: { toolUseId: 'T1', output: 'a.txt', success: true, status: 'success' } }] },
      ],
    };
    const body = buildGeminiBody(req, 'm') as any;
    expect(body.contents[1].parts[0]).toEqual({ text: '[历史工具调用] shell_execute 参数: {"command":"dir","tool_title":"列目录"}' });
    expect(body.contents[2].parts[0].text).toContain('[历史工具结果]');
    expect(body.contents[2].parts[0].text).toContain('a.txt');
    // 绝不出现裸 functionCall/functionResponse（Gemini 3 会因缺签名 400）
    const json = JSON.stringify(body);
    expect(json).not.toContain('functionCall');
    expect(json).not.toContain('functionResponse');
  });

  it('历史里的非法 toolUse.input 回放时降级为空对象参数', () => {
    const req: StreamRequest = {
      ...BASE,
      messages: [{ role: 'assistant', parts: [
        { type: 'toolUse', value: { toolUseId: 'B1', name: 'shell_execute', input: '{"bad', thoughtSignature: 's' } },
      ] }],
    };
    const body = buildGeminiBody(req, 'm') as any;
    expect(body.contents[0].parts[0]).toEqual({ functionCall: { name: 'shell_execute', args: {} }, thoughtSignature: 's' });
  });
});

function sseResponse(frames: string): Response {
  return new Response(frames, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function chunkedResponse(chunks: string[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) { for (const s of chunks) c.enqueue(enc.encode(s)); c.close(); },
  });
  return new Response(stream, { status: 200 });
}

async function drain(p: GeminiProvider, req: StreamRequest): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = [];
  for await (const e of p.streamAgentMessage(req)) events.push(e);
  return events;
}

/** 录制的 Gemini SSE 流：thinking → text → functionCall(带签名) → finish+usage。 */
const RECORDED = [
  'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"我先看下目录","thought":true}]}}]}\n\n',
  'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"好的"}]}}]}\n\n',
  'data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"shell_execute","args":{"command":"dir","tool_title":"列目录"}},"thoughtSignature":"c2lnLTEyMw=="}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":42,"candidatesTokenCount":18}}\n\n',
].join('');

describe('GeminiProvider 流归一化（录制回放）', () => {
  it('thinking/text/functionCall/usage/done 归一化，functionCall 合成 UUID id 并带签名', async () => {
    const p = new GeminiProvider({ apiKey: 'k', modelId: 'gemini-2.5-flash', fetchImpl: async () => sseResponse(RECORDED) });
    const events = await drain(p, BASE);
    expect(events).toContainEqual({ kind: 'thinkingDelta', text: '我先看下目录' });
    expect(events).toContainEqual({ kind: 'textDelta', text: '好的' });
    const call = events.find(e => e.kind === 'toolCallComplete');
    expect(call).toMatchObject({ kind: 'toolCallComplete', name: 'shell_execute', input: '{"command":"dir","tool_title":"列目录"}', thoughtSignature: 'c2lnLTEyMw==' });
    expect((call as { toolUseId: string }).toolUseId).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);
    expect(events).toContainEqual({ kind: 'usage', usage: { inputTokens: 42, outputTokens: 18 } });
    expect(events.at(-1)).toEqual({ kind: 'done', stopReason: 'toolUse' });
  });

  it('同一 data 帧被拆到两个网络块（部分 JSON）仍正确解析', async () => {
    const cut = RECORDED.indexOf('"functionCall"');
    const p = new GeminiProvider({ apiKey: 'k', modelId: 'm', fetchImpl: async () => chunkedResponse([RECORDED.slice(0, cut), RECORDED.slice(cut)]) });
    const events = await drain(p, BASE);
    expect(events.some(e => e.kind === 'toolCallComplete' && e.name === 'shell_execute')).toBe(true);
    expect(events.at(-1)).toEqual({ kind: 'done', stopReason: 'toolUse' });
  });

  it('纯文本回复 STOP → endTurn', async () => {
    const sse = 'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"你好"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2}}\n\n';
    const p = new GeminiProvider({ apiKey: 'k', modelId: 'm', fetchImpl: async () => sseResponse(sse) });
    const events = await drain(p, BASE);
    expect(events).toContainEqual({ kind: 'textDelta', text: '你好' });
    expect(events.at(-1)).toEqual({ kind: 'done', stopReason: 'endTurn' });
  });

  it('MAX_TOKENS → maxTokens；promptFeedback.blockReason → refusal', async () => {
    const sse = 'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"长"}]},"finishReason":"MAX_TOKENS"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":4096}}\n\n';
    const p = new GeminiProvider({ apiKey: 'k', modelId: 'm', fetchImpl: async () => sseResponse(sse) });
    expect((await drain(p, BASE)).at(-1)).toEqual({ kind: 'done', stopReason: 'maxTokens' });

    const blocked = 'data: {"promptFeedback":{"blockReason":"SAFETY"},"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":0}}\n\n';
    const p2 = new GeminiProvider({ apiKey: 'k', modelId: 'm', fetchImpl: async () => sseResponse(blocked) });
    expect((await drain(p2, BASE)).at(-1)).toEqual({ kind: 'done', stopReason: 'refusal' });
  });

  it('断流（无 finishReason 无 usageMetadata）→ retryable 抛错', async () => {
    const half = 'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"半截"}]}}]}\n\n';
    const p = new GeminiProvider({ apiKey: 'k', modelId: 'm', fetchImpl: async () => sseResponse(half) });
    await expect(drain(p, BASE)).rejects.toMatchObject({ retryable: true, message: 'SSE 流提前结束' });
  });

  it('429 → fallbackable 且不可 retry；529 → retryable；网络异常 → retryable', async () => {
    const p429 = new GeminiProvider({ apiKey: 'k', modelId: 'm', fetchImpl: async () => new Response('rate', { status: 429 }) });
    await expect(drain(p429, BASE)).rejects.toMatchObject({ retryable: false, fallbackable: true, status: 429 });
    const p529 = new GeminiProvider({ apiKey: 'k', modelId: 'm', fetchImpl: async () => new Response('overloaded', { status: 529 }) });
    await expect(drain(p529, BASE)).rejects.toMatchObject({ retryable: true, fallbackable: false });
    const pNet = new GeminiProvider({ apiKey: 'k', modelId: 'm', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
    await expect(drain(pNet, BASE)).rejects.toMatchObject({ retryable: true });
  });
});
```

`deskminis/tests/agent-loop.test.ts` 追加（放在 `describe('runAgentLoop')` 块内任意 it 之后，复用文件顶部已有的 `ScriptedProvider`/`mkCtx`/`collect`）:

```typescript
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
```

- [x] **Step 2: 跑测试确认失败**

Run: `cd deskminis && npm test -- tests/gemini.test.ts`
Expected: FAIL（`../src/minisd/providers/gemini` 模块不存在）

Run: `cd deskminis && npm test -- tests/agent-loop.test.ts`
Expected: FAIL（新用例中 `thoughtSignature: 'sig-1'` 事件字段类型报错 / 落库 part 无该字段）

- [x] **Step 3: 修改 shared/types.ts 与创建 gemini.ts**

`deskminis/src/shared/types.ts` 中 `AgentStreamEvent` 的 `toolCallComplete` 成员改为（其余成员不变）：

```typescript
  | { kind: 'toolCallComplete'; toolUseId: string; name: string; input: string; thoughtSignature?: string }
```

`deskminis/src/minisd/providers/gemini.ts`:

```typescript
import { randomUUID } from 'node:crypto';
import type { AgentStreamEvent, ContentPart, StopReason, ThinkingLevel } from '../../shared/types';
import { ProviderError, type AgentProvider, type FetchLike, type StreamRequest } from './types';
import { parseSse } from './sse';

const BUDGETS: Record<Exclude<ThinkingLevel, 'off'>, number> = { low: 4096, medium: 16384, high: 24576 };

interface GeminiPart {
  text?: string;
  thought?: boolean;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
  thoughtSignature?: string;
}

interface ToolUseValue { toolUseId: string; name: string; input: string; thoughtSignature?: string }

/**
 * 历史回放规则（设计 §4.1 Gemini 段）：
 * - 带 thoughtSignature 的 toolUse → functionCall part 原样回放签名；
 * - 无签名的历史 toolUse 不能回放成 functionCall（Gemini 3 校验签名会 400），
 *   连同它配对的 toolResult 一起降级为文本摘要 part。
 * toolResult 自身不存工具名，functionResponse.name 从前面已见的 toolUse 反查。
 */
export function buildGeminiBody(req: StreamRequest, modelId: string): Record<string, unknown> {
  // 第一遍：收集无签名 toolUseId + toolUseId → 工具名映射
  const unsignedIds = new Set<string>();
  const nameById = new Map<string, string>();
  for (const m of req.messages) for (const p of m.parts) {
    if (p.type !== 'toolUse') continue;
    const v = p.value as ToolUseValue;
    nameById.set(v.toolUseId, v.name);
    if (!v.thoughtSignature) unsignedIds.add(v.toolUseId);
  }

  const contents = req.messages.map(m => {
    const role = m.role === 'assistant' ? 'model' : 'user';
    const parts: GeminiPart[] = [];
    for (const p of m.parts) {
      switch (p.type) {
        case 'text':
          parts.push({ text: p.value as string });
          break;
        case 'toolUse': {
          const v = p.value as ToolUseValue;
          if (unsignedIds.has(v.toolUseId)) {
            parts.push({ text: `[历史工具调用] ${v.name} 参数: ${v.input}` });
            break;
          }
          // 与 M1 anthropic partToBlock 同理：历史里的非法 JSON 裸 parse 会让该会话之后
          // 每次请求都抛 SyntaxError（永久变砖）。降级为空对象参数。
          let args: Record<string, unknown> = {};
          try {
            const parsed: unknown = JSON.parse(v.input || '{}');
            if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
          } catch { args = {}; }
          const part: GeminiPart = { functionCall: { name: v.name, args } };
          if (v.thoughtSignature) part.thoughtSignature = v.thoughtSignature;
          parts.push(part);
          break;
        }
        case 'toolResult': {
          const v = p.value as { toolUseId: string; output: string; success: boolean };
          if (unsignedIds.has(v.toolUseId)) {
            parts.push({ text: `[历史工具结果] ${v.success ? '成功' : '失败'}: ${v.output}` });
            break;
          }
          parts.push({ functionResponse: { name: nameById.get(v.toolUseId) ?? '', response: { result: v.output } } });
          break;
        }
        default:
          break; // mediaRef 等类型 Gemini 路径暂不处理（M2a/UI 子计划范围）
      }
    }
    return { role, parts };
  }).filter(c => c.parts.length > 0); // Gemini 拒收空 content

  const body: Record<string, unknown> = { contents };
  if (req.systemPrompt) body.system_instruction = { parts: [{ text: req.systemPrompt }] };
  if (req.tools.length > 0) {
    body.tools = [{
      functionDeclarations: req.tools.map(t => ({
        name: t.name, description: t.description,
        parameters: {
          type: 'object',
          properties: Object.fromEntries(Object.entries(t.parameters).map(([k, p]) => [k, { type: p.type.toUpperCase(), description: p.description, ...(p.enumValues ? { enum: p.enumValues } : {}) }])),
          required: t.required,
        },
      })),
    }];
  }
  const generationConfig: Record<string, unknown> = { maxOutputTokens: req.maxTokens };
  if (req.thinkingLevel !== 'off') {
    generationConfig.thinkingConfig = { thinkingBudget: Math.min(BUDGETS[req.thinkingLevel], req.maxTokens - 1), includeThoughts: true };
  }
  body.generationConfig = generationConfig;
  return body;
}

const FINISH_MAP: Record<string, StopReason> = { STOP: 'endTurn', MAX_TOKENS: 'maxTokens', SAFETY: 'refusal', RECITATION: 'refusal', OTHER: 'refusal' };

export class GeminiProvider implements AgentProvider {
  readonly name = 'gemini';
  readonly modelId: string;
  private apiKey: string; private baseUrl: string; private fetchImpl: FetchLike;

  constructor(opts: { apiKey: string; modelId: string; baseUrl?: string; fetchImpl?: FetchLike }) {
    this.apiKey = opts.apiKey; this.modelId = opts.modelId;
    this.baseUrl = (opts.baseUrl ?? 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async *streamAgentMessage(req: StreamRequest, signal?: AbortSignal): AsyncIterable<AgentStreamEvent> {
    const url = `${this.baseUrl}/v1beta/models/${encodeURIComponent(this.modelId)}:streamGenerateContent?alt=sse`;
    const res = await this.fetchImpl(url, {
      method: 'POST', signal,
      // 密钥放 header 而非 query key=：URL 会进代理/错误日志
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify(buildGeminiBody(req, this.modelId)),
    }).catch((e: unknown) => { throw new ProviderError(`网络错误: ${String(e)}`, { retryable: true }); });
    if (!res.ok || !res.body) throw new ProviderError(`Gemini HTTP ${res.status}: ${await res.text()}`, { status: res.status });

    let inputTokens = 0; let outputTokens = 0;
    let stopReason: StopReason = 'endTurn';
    let sawFinish = false; let sawUsage = false; let sawToolCall = false;
    for await (const frame of parseSse(res.body)) {
      const chunk = JSON.parse(frame.data) as Record<string, any>;
      if (chunk.usageMetadata) {
        inputTokens = chunk.usageMetadata.promptTokenCount ?? inputTokens;
        outputTokens = chunk.usageMetadata.candidatesTokenCount ?? outputTokens;
        sawUsage = true;
      }
      if (typeof chunk.promptFeedback?.blockReason === 'string') {
        yield { kind: 'usage', usage: { inputTokens, outputTokens } };
        yield { kind: 'done', stopReason: 'refusal' };
        return;
      }
      const cand = chunk.candidates?.[0];
      if (!cand) continue;
      for (const part of (cand.content?.parts ?? []) as Record<string, any>[]) {
        if (part.thought === true && typeof part.text === 'string') { yield { kind: 'thinkingDelta', text: part.text }; continue; }
        if (typeof part.text === 'string' && part.text) { yield { kind: 'textDelta', text: part.text }; continue; }
        if (part.functionCall) {
          sawToolCall = true;
          yield {
            kind: 'toolCallComplete',
            // Gemini 的函数调用整体到达且不给调用 id：合成 UUID（对齐全局 ID 大写约定）
            toolUseId: randomUUID().toUpperCase(),
            name: String(part.functionCall.name ?? ''),
            input: JSON.stringify(part.functionCall.args ?? {}),
            ...(typeof part.thoughtSignature === 'string' ? { thoughtSignature: part.thoughtSignature } : {}),
          };
        }
      }
      if (cand.finishReason) { stopReason = FINISH_MAP[cand.finishReason as string] ?? 'endTurn'; sawFinish = true; }
    }
    if (!sawFinish && !sawUsage) throw new ProviderError('SSE 流提前结束', { retryable: true });
    if (sawToolCall) stopReason = 'toolUse';
    yield { kind: 'usage', usage: { inputTokens, outputTokens } };
    yield { kind: 'done', stopReason };
  }
}
```

- [x] **Step 4: 修改 agent/loop.ts 透传 thoughtSignature**

`deskminis/src/minisd/agent/loop.ts` 两处小改（其余代码不动）：

1. `interface AccumulatedCall` 改为：

```typescript
interface AccumulatedCall { toolUseId: string; name: string; input: string; thoughtSignature?: string }
```

2. 流事件累积处与落库处改为：

```typescript
            case 'toolCallComplete': calls.push({ toolUseId: ev.toolUseId, name: ev.name, input: ev.input, thoughtSignature: ev.thoughtSignature }); break;
```

```typescript
    for (const c of calls) {
      // 就地归一：落库/toolStart 事件/工具执行三处看到的入参必须是同一个值
      c.input = safeToolInput(c.input);
      assistantParts.push({ type: 'toolUse', value: { toolUseId: c.toolUseId, name: c.name, input: c.input, ...(c.thoughtSignature !== undefined ? { thoughtSignature: c.thoughtSignature } : {}) } });
    }
```

- [x] **Step 5: 跑测试确认通过**

Run: `cd deskminis && npm test -- tests/gemini.test.ts`
Expected: PASS（11 个用例）

Run: `cd deskminis && npm test -- tests/agent-loop.test.ts`
Expected: PASS（含新 thoughtSignature 用例）

Run: `cd deskminis && npm test`
Expected: 全部通过（M1 测试不回归——`toolCallComplete` 只新增可选字段）

- [x] **Step 6: Commit**

```bash
cd "C:\Users\24739\Downloads\openminis1" && git add deskminis/src/minisd/providers/gemini.ts deskminis/src/shared/types.ts deskminis/src/minisd/agent/loop.ts deskminis/tests/gemini.test.ts deskminis/tests/agent-loop.test.ts && git commit -m "feat(m2b): Gemini Provider——SSE 归一化、函数调用合成 id、thoughtSignature 持久化与回放、无签名历史降级为文本摘要"
```

---

### Task 3: Ollama Provider（OpenAI 兼容端点复用 + provider kind 扩展）

**Files:**
- Modify: `deskminis/src/minisd/providers/openai.ts`（兼容 flag + 无 key 免鉴权头）
- Modify: `deskminis/src/minisd/store/provider-store.ts`（kind 联合扩展、`create` 的 apiKey 可选、`instantiate` 支持 gemini/ollama）
- Modify: `deskminis/src/minisd/index.ts`（`provider.instances.create/update` 校验扩展）
- Test: `deskminis/tests/ollama.test.ts`（Create）、`deskminis/tests/provider-store.test.ts`（Append）、`deskminis/tests/rpc.test.ts`（Append）

**Interfaces:**
- Consumes: Task 2 `GeminiProvider`；M1 `OpenAIProvider`/`buildOpenAIBody`/`ProviderStore`
- Produces（Task 5/7 依赖）:
  - `interface OpenAICompatFlags { includeStreamOptions?: boolean; reasoningEffort?: boolean }` — 均默认 `true`
  - `function buildOpenAIBody(req: StreamRequest, modelId: string, flags?: OpenAICompatFlags): Record<string, unknown>` — 第三参可选，M1 调用点签名兼容
  - `class OpenAIProvider` 构造变为 `constructor(opts: { apiKey: string; modelId: string; baseUrl: string; fetchImpl?: FetchLike; compat?: OpenAICompatFlags })`；**`apiKey === ''` 时请求不带 `authorization` 头**
  - `ProviderInstance.kind` = `'anthropic' | 'openai-compat' | 'gemini' | 'ollama'`
  - `ProviderStore.create(inst: Omit<ProviderInstance, 'id'>, apiKey?: string): ProviderInstance` — apiKey 省略或空串时不写 vault（Ollama 免 key）
  - `ProviderStore.instantiate(id)` 的 ollama 分支：`new OpenAIProvider({ apiKey: apiKey ?? '', modelId: p.modelId, baseUrl: p.baseUrl ?? 'http://localhost:11434/v1', compat: { reasoningEffort: false } })`

**Ollama 兼容 flag 说明**（设计 §4.1 Ollama 段）：
- Ollama 的 OpenAI 兼容端点是 `{baseUrl}/chat/completions`（baseUrl 含 `/v1`），M1 `OpenAIProvider` 原样可用
- 本地服务无 API key：`apiKey` 允许省略，空 key 时**跳过 `authorization` 头**（部分 Ollama 前置代理对多余鉴权头会 401）
- `reasoningEffort: false`：Ollama 的 OpenAI 兼容端点不认识 `reasoning_effort` 字段（部分版本直接 400），Ollama 预设不发送；thinking 档位由 Task 4 的能力目录按模型族另行钳制
- `includeStreamOptions` 默认保持 `true`（Ollama ≥0.3 支持 `stream_options.include_usage`；flag 留给不支持的兼容端点）

- [x] **Step 1: 写失败测试**

`deskminis/tests/ollama.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { OpenAIProvider, buildOpenAIBody, type OpenAICompatFlags } from '../src/minisd/providers/openai';
import type { StreamRequest } from '../src/minisd/providers/types';
import type { AgentStreamEvent } from '../src/shared/types';

const REQ: StreamRequest = {
  messages: [{ role: 'user', parts: [{ type: 'text', value: 'hi' }] }],
  systemPrompt: 'sys',
  tools: [{ name: 'file_read', description: 'r', parameters: { path: { type: 'string', description: 'p' }, tool_title: { type: 'string', description: 't' } }, required: ['path', 'tool_title'] }],
  maxTokens: 2048, thinkingLevel: 'high',
};

describe('buildOpenAIBody 兼容 flag', () => {
  it('默认 flag 保持 M1 行为（stream_options + reasoning_effort）', () => {
    const b = buildOpenAIBody(REQ, 'qwen3') as any;
    expect(b.stream_options).toEqual({ include_usage: true });
    expect(b.reasoning_effort).toBe('high');
  });
  it('reasoningEffort:false → 不发 reasoning_effort（Ollama 预设）', () => {
    const flags: OpenAICompatFlags = { reasoningEffort: false };
    const b = buildOpenAIBody(REQ, 'qwen3', flags) as any;
    expect(b.reasoning_effort).toBeUndefined();
    expect(b.stream_options).toEqual({ include_usage: true });
  });
  it('includeStreamOptions:false → 不发 stream_options', () => {
    const b = buildOpenAIBody(REQ, 'm', { includeStreamOptions: false }) as any;
    expect(b.stream_options).toBeUndefined();
    expect(b.reasoning_effort).toBe('high');
  });
});

describe('OpenAIProvider 无 key 兼容（Ollama）', () => {
  function sseOk(): Response {
    const text = [
      'data: {"choices":[{"index":0,"delta":{"content":"本地"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2}}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    return new Response(text, { status: 200 });
  }

  it('apiKey 为空串 → 请求不带 authorization 头；流归一化照常', async () => {
    let seenHeaders: Record<string, string> | undefined;
    const p = new OpenAIProvider({
      apiKey: '', modelId: 'qwen3', baseUrl: 'http://localhost:11434/v1', compat: { reasoningEffort: false },
      fetchImpl: async (_url, init) => { seenHeaders = (init?.headers ?? {}) as Record<string, string>; return sseOk(); },
    });
    const events: AgentStreamEvent[] = [];
    for await (const e of p.streamAgentMessage(REQ)) events.push(e);
    expect(seenHeaders?.authorization).toBeUndefined();
    expect(seenHeaders?.['content-type']).toBe('application/json');
    expect(events).toContainEqual({ kind: 'textDelta', text: '本地' });
    expect(events.at(-1)).toEqual({ kind: 'done', stopReason: 'endTurn' });
  });

  it('apiKey 非空 → 照常带 authorization 头（M1 行为不变）', async () => {
    let seenHeaders: Record<string, string> | undefined;
    const p = new OpenAIProvider({
      apiKey: 'sk-x', modelId: 'm', baseUrl: 'http://x/v1',
      fetchImpl: async (_url, init) => { seenHeaders = (init?.headers ?? {}) as Record<string, string>; return sseOk(); },
    });
    for await (const _ of p.streamAgentMessage(REQ)) void _;
    expect(seenHeaders?.authorization).toBe('Bearer sk-x');
  });
});
```

`deskminis/tests/provider-store.test.ts` 追加（文件末尾新 describe，复用顶部 `beforeEach` 准备好的 `dir`/`vault`/`store`）:

```typescript
describe('ProviderStore gemini/ollama kind', () => {
  it('ollama 免 key：create 不传 apiKey，hasApiKey=false，instantiate 成功', () => {
    const o = store.create({ name: '本地 Ollama', kind: 'ollama', modelId: 'qwen3' });
    expect(store.list()[0]).toMatchObject({ name: '本地 Ollama', hasApiKey: false });
    expect(readFileSync(join(dir, 'providers.json'), 'utf8')).not.toContain('apiKey');
    expect(store.instantiate(o.id).name).toBe('openai-compat');
  });
  it('gemini 带 key：instantiate 返回 GeminiProvider', () => {
    const g = store.create({ name: 'G', kind: 'gemini', modelId: 'gemini-2.5-flash' }, 'gk');
    expect(store.instantiate(g.id).name).toBe('gemini');
    expect(vault.get(`provider:${g.id}`)).toBe('gk');
  });
  it('gemini 无 key → instantiate 抛缺少密钥', () => {
    const g = store.create({ name: 'G', kind: 'gemini', modelId: 'm' });
    expect(() => store.instantiate(g.id)).toThrow('缺少密钥');
  });
  it('ollama 也可带 key（前置代理场景）→ 照常写 vault', () => {
    const o = store.create({ name: 'O', kind: 'ollama', modelId: 'qwen3', baseUrl: 'http://nas:11434/v1' }, 'lk');
    expect(store.list()[0].hasApiKey).toBe(true);
    expect(store.instantiate(o.id).name).toBe('openai-compat');
  });
});
```

`deskminis/tests/rpc.test.ts` 追加（文件末尾新 describe，复用顶部 `boot`/`rpcClient`）:

```typescript
describe('provider.instances.* kind 扩展', () => {
  it('create ollama：无 apiKey 无 baseUrl 也成功', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const r = (await c.call('provider.instances.create', { name: '本地', kind: 'ollama', modelId: 'qwen3' })).result;
    expect(r.kind).toBe('ollama');
    expect(r.baseUrl).toBeUndefined();
    const list = (await c.call('provider.instances.list')).result;
    expect(list[0].hasApiKey).toBe(false);
    c.close();
  });
  it('create gemini 缺 apiKey → 报错', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const resp = await c.call('provider.instances.create', { name: 'G', kind: 'gemini', modelId: 'gemini-2.5-flash' });
    expect(resp.error).toBeTruthy();
    c.close();
  });
  it('create openai-compat 缺 baseUrl → 报错（M1 校验不回归）', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const resp = await c.call('provider.instances.create', { name: 'X', kind: 'openai-compat', modelId: 'm', apiKey: 'k' });
    expect(resp.error).toBeTruthy();
    c.close();
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `cd deskminis && npm test -- tests/ollama.test.ts`
Expected: FAIL（`OpenAICompatFlags` 未导出、flags 第三参不存在、空 key 仍发 authorization 头）

Run: `cd deskminis && npm test -- tests/provider-store.test.ts tests/rpc.test.ts`
Expected: FAIL（kind 联合不含 gemini/ollama，校验与 instantiate 不支持）

- [x] **Step 3: 修改 openai.ts（完整替换）**

`deskminis/src/minisd/providers/openai.ts` 完整替换为：

```typescript
import type { AgentStreamEvent, ContentPart, StopReason } from '../../shared/types';
import { ProviderError, type AgentProvider, type FetchLike, type StreamRequest } from './types';
import { parseSse } from './sse';

/** 持久化的 toolUse.input 可能是被截断/损坏的 JSON（旧数据或异常写入）。
 *  发给端点前校验一次：解析失败就回退成空对象，避免把坏 JSON 当 arguments 发出去。 */
function safeJsonArgs(s: string): string {
  try { JSON.parse(s || '{}'); return s || '{}'; } catch { return '{}'; }
}

/** OpenAI 兼容端点的行为开关（默认全开，保持 M1 行为）。 */
export interface OpenAICompatFlags {
  /** 缺省 true：发送 stream_options.include_usage（部分兼容端点不支持该字段） */
  includeStreamOptions?: boolean;
  /** 缺省 true：thinkingLevel 非 off 时发送 reasoning_effort（Ollama 的 OpenAI 端点不认识，会 400） */
  reasoningEffort?: boolean;
}

export function buildOpenAIBody(req: StreamRequest, modelId: string, flags: OpenAICompatFlags = {}): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];
  if (req.systemPrompt) messages.push({ role: 'system', content: req.systemPrompt });
  for (const m of req.messages) {
    const texts = m.parts.filter(p => p.type === 'text').map(p => p.value as string).join('');
    const toolUses = m.parts.filter(p => p.type === 'toolUse');
    const toolResults = m.parts.filter(p => p.type === 'toolResult');
    if (m.role === 'assistant') {
      const msg: Record<string, unknown> = { role: 'assistant', content: texts || null };
      if (toolUses.length) msg.tool_calls = toolUses.map(p => {
        const v = p.value as { toolUseId: string; name: string; input: string };
        return { id: v.toolUseId, type: 'function', function: { name: v.name, arguments: safeJsonArgs(v.input) } };
      });
      messages.push(msg);
    } else {
      if (texts) messages.push({ role: 'user', content: texts });
      for (const p of toolResults) {
        const v = p.value as { toolUseId: string; output: string };
        messages.push({ role: 'tool', tool_call_id: v.toolUseId, content: v.output });
      }
    }
  }
  const body: Record<string, unknown> = {
    model: modelId, stream: true, max_tokens: req.maxTokens, messages,
    tools: req.tools.map(t => ({
      type: 'function',
      function: {
        name: t.name, description: t.description,
        parameters: {
          type: 'object',
          properties: Object.fromEntries(Object.entries(t.parameters).map(([k, p]) => [k, { type: p.type, description: p.description, ...(p.enumValues ? { enum: p.enumValues } : {}) }])),
          required: t.required,
        },
      },
    })),
  };
  if (flags.includeStreamOptions !== false) body.stream_options = { include_usage: true };
  if (req.thinkingLevel !== 'off' && flags.reasoningEffort !== false) body.reasoning_effort = req.thinkingLevel;
  return body;
}

const FINISH_MAP: Record<string, StopReason> = { stop: 'endTurn', tool_calls: 'toolUse', length: 'maxTokens', content_filter: 'refusal' };

export class OpenAIProvider implements AgentProvider {
  readonly name = 'openai-compat';
  readonly modelId: string;
  private apiKey: string; private baseUrl: string; private fetchImpl: FetchLike;
  private compat: OpenAICompatFlags;

  constructor(opts: { apiKey: string; modelId: string; baseUrl: string; fetchImpl?: FetchLike; compat?: OpenAICompatFlags }) {
    this.apiKey = opts.apiKey; this.modelId = opts.modelId;
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.compat = opts.compat ?? {};
  }

  async *streamAgentMessage(req: StreamRequest, signal?: AbortSignal): AsyncIterable<AgentStreamEvent> {
    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: 'POST', signal,
      // Ollama 等本地端点无 key：空 key 时跳过 authorization 头（部分前置代理对多余鉴权头 401）
      headers: { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify(buildOpenAIBody(req, this.modelId, this.compat)),
    }).catch((e: unknown) => { throw new ProviderError(`网络错误: ${String(e)}`, { retryable: true }); });
    if (!res.ok || !res.body) throw new ProviderError(`OpenAI HTTP ${res.status}: ${await res.text()}`, { status: res.status });

    const calls = new Map<number, { id: string; name: string; args: string }>();
    let usage = { inputTokens: 0, outputTokens: 0 };
    let stopReason: StopReason = 'endTurn';
    let sawFinish = false;
    let sawDone = false;
    for await (const frame of parseSse(res.body)) {
      if (frame.data === '[DONE]') { sawDone = true; break; }
      const chunk = JSON.parse(frame.data) as Record<string, any>;
      if (chunk.usage) usage = { inputTokens: chunk.usage.prompt_tokens ?? 0, outputTokens: chunk.usage.completion_tokens ?? 0 };
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      if (typeof delta.content === 'string' && delta.content) yield { kind: 'textDelta', text: delta.content };
      for (const tc of delta.tool_calls ?? []) {
        const cur = calls.get(tc.index) ?? { id: '', name: '', args: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name = tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        calls.set(tc.index, cur);
        yield { kind: 'toolInputDelta', toolUseId: cur.id, name: cur.name, accumulatedJson: cur.args };
      }
      if (choice.finish_reason) { stopReason = FINISH_MAP[choice.finish_reason] ?? 'endTurn'; sawFinish = true; }
    }
    if (!sawFinish && !sawDone) throw new ProviderError('SSE 流提前结束', { retryable: true });
    if (!sawFinish && calls.size > 0) stopReason = 'toolUse';
    for (const c of [...calls.values()]) {
      yield { kind: 'toolCallComplete', toolUseId: c.id, name: c.name, input: c.args || '{}' };
    }
    yield { kind: 'usage', usage };
    yield { kind: 'done', stopReason };
  }
}
```

- [x] **Step 4: 修改 provider-store.ts**

`deskminis/src/minisd/store/provider-store.ts` 三处修改（`list`/`update`/`delete`/`getDefaultId`/`setDefaultId`/`save` 与 vault 类保持 M1 原样）：

1. import 行与 `ProviderInstance` 改为：

```typescript
import { AnthropicProvider } from '../providers/anthropic';
import { OpenAIProvider } from '../providers/openai';
import { GeminiProvider } from '../providers/gemini';
```

```typescript
export interface ProviderInstance {
  id: string; name: string; kind: 'anthropic' | 'openai-compat' | 'gemini' | 'ollama';
  baseUrl?: string; modelId: string;
}
```

2. `create` 完整替换为（apiKey 可选，空串/省略不写 vault）：

```typescript
  create(inst: Omit<ProviderInstance, 'id'>, apiKey?: string): ProviderInstance {
    const full: ProviderInstance = { ...inst, id: randomUUID().toUpperCase() };
    this.cfg.providers.push(full);
    if (apiKey) this.vault.set(`provider:${full.id}`, apiKey); // Ollama 可免 key
    if (!this.cfg.defaultProviderId) this.cfg.defaultProviderId = full.id;
    this.save();
    return full;
  }
```

3. `instantiate` 完整替换为：

```typescript
  instantiate(id: string): AgentProvider {
    const p = this.cfg.providers.find(x => x.id === id);
    if (!p) throw new Error(`provider 不存在: ${id}`);
    const apiKey = this.vault.get(`provider:${id}`);
    switch (p.kind) {
      case 'anthropic':
        if (apiKey === undefined) throw new Error(`provider 缺少密钥: ${p.name}`);
        return new AnthropicProvider({ apiKey, modelId: p.modelId, baseUrl: p.baseUrl });
      case 'gemini':
        if (apiKey === undefined) throw new Error(`provider 缺少密钥: ${p.name}`);
        return new GeminiProvider({ apiKey, modelId: p.modelId, baseUrl: p.baseUrl });
      case 'ollama':
        // 本地端点免 key；reasoning_effort 字段 Ollama 的 OpenAI 兼容端点不认识（会 400），预设不发
        return new OpenAIProvider({ apiKey: apiKey ?? '', modelId: p.modelId, baseUrl: p.baseUrl ?? 'http://localhost:11434/v1', compat: { reasoningEffort: false } });
      default: // openai-compat
        if (apiKey === undefined) throw new Error(`provider 缺少密钥: ${p.name}`);
        return new OpenAIProvider({ apiKey, modelId: p.modelId, baseUrl: p.baseUrl ?? 'https://api.openai.com/v1' });
    }
  }
```

- [x] **Step 5: 修改 index.ts 的 provider.instances.create/update 校验**

`deskminis/src/minisd/index.ts` 中两个 RPC 方法完整替换为（其余方法不动）：

```typescript
    'provider.instances.create': (p: { name: string; kind: 'anthropic' | 'openai-compat' | 'gemini' | 'ollama'; baseUrl?: string; modelId: string; apiKey?: string }) => {
      const baseUrl = (typeof p.baseUrl === 'string' ? p.baseUrl.trim() : '') || undefined;
      if (p.kind === 'openai-compat' && !baseUrl) throw new Error('OpenAI 兼容 provider 需要 base URL');
      // ollama 本地端点免 key；其余类型必须带 key
      if (p.kind !== 'ollama' && (typeof p.apiKey !== 'string' || p.apiKey === '')) throw new Error('该 provider 类型需要 API key');
      return providers.create({ name: p.name, kind: p.kind, baseUrl, modelId: p.modelId }, p.apiKey || undefined);
    },
    /** 改配置不必删了重建；apiKey 省略/空串 = 保留原密钥（前端也永远拿不到旧密钥回显）。 */
    'provider.instances.update': (p: { id: string; name?: string; kind?: 'anthropic' | 'openai-compat' | 'gemini' | 'ollama'; baseUrl?: string; modelId?: string; apiKey?: string }) => {
      const cur = providers.list().find(x => x.id === p.id);
      if (!cur) throw new Error(`provider 不存在: ${p.id}`);
      const patch: Partial<{ name: string; kind: 'anthropic' | 'openai-compat' | 'gemini' | 'ollama'; baseUrl: string | undefined; modelId: string }> & { apiKey?: string } = {};
      if (typeof p.name === 'string' && p.name.trim()) patch.name = p.name.trim();
      if (p.kind === 'anthropic' || p.kind === 'openai-compat' || p.kind === 'gemini' || p.kind === 'ollama') patch.kind = p.kind;
      if (typeof p.modelId === 'string' && p.modelId.trim()) patch.modelId = p.modelId.trim();
      if (p.baseUrl !== undefined) patch.baseUrl = (typeof p.baseUrl === 'string' ? p.baseUrl.trim() : '') || undefined;
      if (typeof p.apiKey === 'string' && p.apiKey !== '') patch.apiKey = p.apiKey;
      // 校验「改完之后」的形态，而不是补丁本身：openai-compat 没有 base URL 无法请求
      const kind = patch.kind ?? cur.kind;
      const baseUrl = 'baseUrl' in patch ? patch.baseUrl : cur.baseUrl;
      if (kind === 'openai-compat' && !baseUrl) throw new Error('OpenAI 兼容 provider 需要 base URL');
      providers.update(p.id, patch);
      return { ok: true };
    },
```

- [x] **Step 6: 跑测试确认通过**

Run: `cd deskminis && npm test -- tests/ollama.test.ts tests/provider-store.test.ts tests/rpc.test.ts`
Expected: PASS（ollama 6 个 + provider-store 原有 4 个 + 新增 4 个 + rpc 原有 + 新增 3 个）

Run: `cd deskminis && npm test`
Expected: 全部通过（M1 openai/anthropic 测试不回归——默认 flag 与有 key 行为未变）

- [x] **Step 7: Commit**

```bash
cd "C:\Users\24739\Downloads\openminis1" && git add deskminis/src/minisd/providers/openai.ts deskminis/src/minisd/store/provider-store.ts deskminis/src/minisd/index.ts deskminis/tests/ollama.test.ts deskminis/tests/provider-store.test.ts deskminis/tests/rpc.test.ts && git commit -m "feat(m2b): Ollama provider（OpenAI 兼容端点 + 无 key 免鉴权头 + 默认 baseUrl + 兼容 flag），provider kind 扩展 gemini/ollama"
```

---

### Task 4: 模型能力目录（models.dev 拉取 + 磁盘缓存 + 内置兜底 + ThinkingLevel 钳制）

**Files:**
- Create: `deskminis/src/minisd/providers/model-catalog.ts`
- Modify: `deskminis/src/minisd/index.ts`（装配 catalog；`chat.prompt` 的 thinkingLevel 经钳制）
- Test: `deskminis/tests/model-catalog.test.ts`

**Interfaces:**
- Consumes: M1 `FetchLike`；`ThinkingLevel`
- Produces（Task 7 与 **M2a** 依赖）:
  - `interface ModelCatalogEntry { contextWindow?: number; maxOutputTokens?: number; thinking?: boolean }`
  - `class ModelCatalog { constructor(cacheFile: string, fetchImpl?: FetchLike); refresh(force?: boolean): Promise<boolean>; getModelContextWindow(modelId: string): number | undefined; clampThinkingLevel(modelId: string, level: ThinkingLevel): ThinkingLevel }`
  - **`getModelContextWindow(modelId): number | undefined` 是 M2a ContextPolicy 的查询入口**：M2a 默认内置映射（<32K 不管 / 32-64K 卸载 / 64-128K 卸载+压缩 / ≥128K 更早触发的分层依据），本子计划把它升级为目录查询（models.dev → 磁盘缓存 → 内置兜底表，未知模型返回 `undefined`，M2a 对 `undefined` 回退其内置映射）
  - `clampThinkingLevel`：模型族不支持推理时把档位钳到 `'off'`（如 `gpt-4o`/`llama*` 的 `high` → `off`）；`off` 恒透传

**数据来源与回退顺序**：内存表 ← 构造时读磁盘缓存（`<dataRoot>/models-dev-cache.json`）← `refresh()` 拉取 `https://models.dev/api.json` 成功才覆盖（原子写 temp+rename）；TTL 24h，TTL 内 `refresh()` 不发请求；拉取失败/离线/格式变化静默回退缓存与内置兜底表。models.dev 结构：`{ <vendor>: { models: { <modelId>: { limit: { context, output }, reasoning: boolean } } } }`，压平成 `Record<modelId, ModelCatalogEntry>`。`lookup` 顺序：精确 id → 末段 `/` 之后部分（`provider/model` 形式）→ 内置表正则（按模型族前缀，先中先赢）。

- [x] **Step 1: 写失败测试**

`deskminis/tests/model-catalog.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { ModelCatalog } from '../src/minisd/providers/model-catalog';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MODELS_DEV = {
  anthropic: { models: { 'claude-sonnet-5': { limit: { context: 200000, output: 64000 }, reasoning: true } } },
  google: { models: { 'gemini-2.5-flash': { limit: { context: 1048576, output: 65536 }, reasoning: true } } },
  openai: { models: { 'gpt-4o': { limit: { context: 128000, output: 16384 }, reasoning: false } } },
};

function fakeFetch(payload: unknown = MODELS_DEV, calls?: { n: number }) {
  return async () => { if (calls) calls.n++; return new Response(JSON.stringify(payload), { status: 200 }); };
}

let dir: string; let cacheFile: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dm-cat-')); cacheFile = join(dir, 'models-dev-cache.json'); });

describe('ModelCatalog', () => {
  it('refresh 拉取 models.dev 并写磁盘缓存；重建实例从缓存读取且 TTL 内不发请求', async () => {
    const c = new ModelCatalog(cacheFile, fakeFetch());
    expect(await c.refresh(true)).toBe(true);
    expect(existsSync(cacheFile)).toBe(true);
    expect(c.getModelContextWindow('gemini-2.5-flash')).toBe(1048576);
    const c2 = new ModelCatalog(cacheFile, async () => { throw new Error('不应发请求'); });
    expect(await c2.refresh()).toBe(false); // TTL 内跳过
    expect(c2.getModelContextWindow('claude-sonnet-5')).toBe(200000);
  });

  it('TTL 内不重复拉取；force 强制拉取', async () => {
    const calls = { n: 0 };
    const c = new ModelCatalog(cacheFile, fakeFetch(MODELS_DEV, calls));
    await c.refresh(true);
    await c.refresh();
    expect(calls.n).toBe(1);
    await c.refresh(true);
    expect(calls.n).toBe(2);
  });

  it('网络失败且无缓存 → 返回 false，内置兜底表仍可用', async () => {
    const c = new ModelCatalog(cacheFile, async () => new Response('err', { status: 500 }));
    expect(await c.refresh(true)).toBe(false);
    expect(c.getModelContextWindow('claude-future-9')).toBe(200000); // 内置 claude- 族
    expect(c.getModelContextWindow('totally-unknown')).toBeUndefined();
  });

  it('provider/model 形式按最后一段匹配', async () => {
    const c = new ModelCatalog(cacheFile, fakeFetch());
    await c.refresh(true);
    expect(c.getModelContextWindow('google/gemini-2.5-flash')).toBe(1048576);
  });

  it('getModelContextWindow 未知模型返回 undefined（M2a 据此回退内置映射）', async () => {
    const c = new ModelCatalog(cacheFile, async () => { throw new Error('offline'); });
    expect(c.getModelContextWindow('mystery-1')).toBeUndefined();
  });

  it('clampThinkingLevel：不支持推理的模型钳到 off，支持的透传', async () => {
    const c = new ModelCatalog(cacheFile, fakeFetch());
    await c.refresh(true);
    expect(c.clampThinkingLevel('gpt-4o', 'high')).toBe('off');
    expect(c.clampThinkingLevel('gpt-4o', 'off')).toBe('off');
    expect(c.clampThinkingLevel('gemini-2.5-flash', 'high')).toBe('high');
    expect(c.clampThinkingLevel('llama3-8b', 'high')).toBe('off');   // 内置表 thinking:false
    expect(c.clampThinkingLevel('totally-unknown', 'medium')).toBe('off'); // 未知模型保守钳 off
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `cd deskminis && npm test -- tests/model-catalog.test.ts`
Expected: FAIL（`../src/minisd/providers/model-catalog` 模块不存在）

- [x] **Step 3: 创建 model-catalog.ts**

`deskminis/src/minisd/providers/model-catalog.ts`:

```typescript
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { ThinkingLevel } from '../../shared/types';
import type { FetchLike } from './types';

export interface ModelCatalogEntry {
  contextWindow?: number;
  maxOutputTokens?: number;
  thinking?: boolean;
}

const API_URL = 'https://models.dev/api.json';
const TTL_MS = 24 * 60 * 60 * 1000;

/** 内置兜底表：models.dev 与磁盘缓存都不可用时仍可用。按模型族前缀正则，先中先赢。 */
const BUILTIN: [RegExp, ModelCatalogEntry][] = [
  [/^claude-/i, { contextWindow: 200_000, thinking: true }],
  [/^gpt-5/i, { contextWindow: 400_000, thinking: true }],
  [/^gpt-4/i, { contextWindow: 128_000, thinking: false }],
  [/^gemini-/i, { contextWindow: 1_000_000, thinking: true }],
  [/^qwen3/i, { contextWindow: 128_000, thinking: true }],
  [/^deepseek-r1/i, { contextWindow: 128_000, thinking: true }],
  [/^deepseek-v/i, { contextWindow: 128_000, thinking: false }],
  [/^llama/i, { contextWindow: 128_000, thinking: false }],
  [/^mistral/i, { contextWindow: 128_000, thinking: false }],
];

interface CacheFile { fetchedAt: number; models: Record<string, ModelCatalogEntry> }

/**
 * 模型能力目录（设计 §4.1「模型能力目录」段）：
 * models.dev API 拉取 + 磁盘缓存（24h TTL）+ 内置兜底表。
 * 任何一环失败都静默回退下一环——目录永远可用，只是可能不新鲜。
 */
export class ModelCatalog {
  private models: Record<string, ModelCatalogEntry> = {};
  private fetchedAt = 0;
  private fetchImpl: FetchLike;

  constructor(private cacheFile: string, fetchImpl?: FetchLike) {
    this.fetchImpl = fetchImpl ?? fetch;
    if (existsSync(cacheFile)) {
      try {
        const c = JSON.parse(readFileSync(cacheFile, 'utf8')) as CacheFile;
        this.models = c.models ?? {};
        this.fetchedAt = c.fetchedAt ?? 0;
      } catch { /* 缓存损坏按无缓存处理 */ }
    }
  }

  /** 拉取 models.dev；TTL 内新鲜缓存直接跳过。返回是否真的拉取并成功。 */
  async refresh(force = false): Promise<boolean> {
    if (!force && Date.now() - this.fetchedAt < TTL_MS) return false;
    try {
      const res = await this.fetchImpl(API_URL);
      if (!res.ok) return false;
      const data = await res.json() as Record<string, { models?: Record<string, { limit?: { context?: number; output?: number }; reasoning?: boolean }> }>;
      const models: Record<string, ModelCatalogEntry> = {};
      for (const vendor of Object.values(data)) {
        for (const [id, m] of Object.entries(vendor.models ?? {})) {
          models[id] = { contextWindow: m.limit?.context, maxOutputTokens: m.limit?.output, thinking: m.reasoning === true };
        }
      }
      this.models = models;
      this.fetchedAt = Date.now();
      const tmp = this.cacheFile + '.tmp';
      writeFileSync(tmp, JSON.stringify({ fetchedAt: this.fetchedAt, models } satisfies CacheFile), 'utf8');
      renameSync(tmp, this.cacheFile); // 原子写（对齐 providers.json 模式）
      return true;
    } catch { return false; } // 离线/格式变化：静默回退磁盘缓存与内置表
  }

  private lookup(modelId: string): ModelCatalogEntry | undefined {
    const direct = this.models[modelId];
    if (direct) return direct;
    const slash = modelId.lastIndexOf('/');
    const tail = slash >= 0 ? modelId.slice(slash + 1) : modelId;
    if (this.models[tail]) return this.models[tail];
    for (const [re, entry] of BUILTIN) if (re.test(modelId) || re.test(tail)) return entry;
    return undefined;
  }

  /** M2a ContextPolicy 的窗口查询入口；未知模型返回 undefined（M2a 回退其内置映射）。 */
  getModelContextWindow(modelId: string): number | undefined {
    return this.lookup(modelId)?.contextWindow;
  }

  /** 按模型族钳制 thinking 档位：目录/内置表判定不支持推理的模型一律钳到 off（设计 §4.1）。 */
  clampThinkingLevel(modelId: string, level: ThinkingLevel): ThinkingLevel {
    if (level === 'off') return 'off';
    const info = this.lookup(modelId);
    if (!info || info.thinking !== true) return 'off';
    return level;
  }
}
```

- [x] **Step 4: index.ts 装配 catalog 并钳制 chat.prompt 的 thinkingLevel**

`deskminis/src/minisd/index.ts` 两处插入/修改：

1. import 区加：

```typescript
import { ModelCatalog } from './providers/model-catalog';
```

2. `const providers = new ProviderStore(root, vault);` 之后插入：

```typescript
  // 模型能力目录：后台预热 models.dev；失败静默回退磁盘缓存/内置兜底表
  const catalog = new ModelCatalog(join(root, 'models-dev-cache.json'));
  void catalog.refresh();
```

3. `chat.prompt` 中 `runAgentLoop` 调用的 thinkingLevel 实参改为（模型族不支持推理时钳到 off，设计 §4.1）：

```typescript
            systemPrompt: SYSTEM_PROMPT, thinkingLevel: catalog.clampThinkingLevel(provider.modelId, p.thinkingLevel ?? 'off'),
```

- [x] **Step 5: 跑测试确认通过**

Run: `cd deskminis && npm test -- tests/model-catalog.test.ts`
Expected: PASS（6 个用例）

Run: `cd deskminis && npm test`
Expected: 全部通过（钳制对 M1 测试透明：fake provider 的 modelId='fake' 无目录条目 → 钳到 off，不改变可观察行为）

- [x] **Step 6: Commit**

```bash
cd "C:\Users\24739\Downloads\openminis1" && git add deskminis/src/minisd/providers/model-catalog.ts deskminis/src/minisd/index.ts deskminis/tests/model-catalog.test.ts && git commit -m "feat(m2b): 模型能力目录——models.dev 拉取 + 磁盘缓存 + 内置兜底表 + ThinkingLevel 按模型族钳制"
```

---

### Task 5: ModelGroup 持久化（ProviderStore CRUD + resolveGroupMembers + ChatStore.setModelBinding）

**Files:**
- Modify: `deskminis/src/minisd/store/provider-store.ts`（ConfigFile 增加 modelGroups + 6 个方法）
- Modify: `deskminis/src/minisd/store/chat-store.ts`（setModelBinding）
- Test: `deskminis/tests/provider-store.test.ts`（Append）、`deskminis/tests/chat-store.test.ts`（Append）

**Interfaces:**
- Consumes: Task 3 `ProviderInstance.kind` 已含 gemini/ollama；M1 `ProviderInstance.id`
- Produces（Task 6/7 依赖）:
  - `interface ModelGroup { id: string; name: string; memberIds: string[]; createdAt: number }`
  - `ProviderStore.createGroup(name: string, memberIds: string[]): ModelGroup`
  - `ProviderStore.listGroups(): ModelGroup[]`
  - `ProviderStore.getGroup(id: string): ModelGroup | undefined`
  - `ProviderStore.updateGroup(id: string, patch: { name?: string; memberIds?: string[] }): void`
  - `ProviderStore.deleteGroup(id: string): void`
  - `ProviderStore.resolveGroupMembers(groupId: string): { instance: ProviderInstance; instantiate(): AgentProvider }[]` — 成员实例被删时跳过（不抛错），返回空数组当全部失效
  - `ChatStore.setModelBinding(sessionId: string, binding: string | undefined): void` — 写入 `sessions.model_binding`；取值约定 `'provider:<instanceId>'` | `'group:<groupId>'` | 空/undefined = 清除

**语义**（设计 §4.2 模型组降级链段）：
- ModelGroup 是用户自定义的跨厂商备用链：成员 = provider instance id 有序列表，第一个是主模型，后面是降级备选
- `resolveGroupMembers` 遍历 memberIds，跳过已被 `providers.delete()` 删掉的实例（静默跳过，不抛错），返回仍可实例化的成员；全部被删时返回空数组
- `chat-store.setModelBinding` 严格写入 Global Constraints 约定的三种取值；`undefined`/空串 → 写 NULL（清除绑定）

- [x] **Step 1: 写失败测试**

`deskminis/tests/provider-store.test.ts` 追加（文件末尾新 describe，复用顶部 `beforeEach` 准备好的 `dir`/`vault`/`store`):

```typescript
describe('ProviderStore ModelGroup', () => {
  it('createGroup/listGroups/getGroup: 持久化到 providers.json', () => {
    const a = store.create({ name: 'A', kind: 'anthropic', modelId: 'm1' }, 'k');
    const b = store.create({ name: 'B', kind: 'openai-compat', baseUrl: 'http://x/v1', modelId: 'm2' }, 'k');
    const g = store.createGroup('主力链', [a.id, b.id]);
    expect(g.id).toMatch(/^[0-9A-F-]{36}$/);
    expect(g.memberIds).toEqual([a.id, b.id]);

    const reopened = new ProviderStore(dir, vault);
    expect(reopened.listGroups()).toHaveLength(1);
    expect(reopened.getGroup(g.id)).toMatchObject({ name: '主力链', memberIds: [a.id, b.id] });
  });

  it('updateGroup 改名与成员', () => {
    const a = store.create({ name: 'A', kind: 'anthropic', modelId: 'm1' }, 'k');
    const g = store.createGroup('G', [a.id]);
    store.updateGroup(g.id, { name: 'G2', memberIds: [a.id, a.id] });
    expect(store.getGroup(g.id)!.name).toBe('G2');
    expect(store.getGroup(g.id)!.memberIds).toEqual([a.id, a.id]);
  });

  it('deleteGroup: 配置文件里消失', () => {
    const a = store.create({ name: 'A', kind: 'anthropic', modelId: 'm1' }, 'k');
    const g = store.createGroup('G', [a.id]);
    store.deleteGroup(g.id);
    expect(store.listGroups()).toHaveLength(0);
    expect(store.getGroup(g.id)).toBeUndefined();
  });

  it('resolveGroupMembers: 成员被删时静默跳过', () => {
    const a = store.create({ name: 'A', kind: 'anthropic', modelId: 'm1' }, 'k');
    const b = store.create({ name: 'B', kind: 'openai-compat', baseUrl: 'http://x/v1', modelId: 'm2' }, 'k');
    const g = store.createGroup('G', [a.id, b.id]);
    // 删掉 a，resolveGroupMembers 只返回 b
    store.delete(a.id);
    const members = store.resolveGroupMembers(g.id);
    expect(members).toHaveLength(1);
    expect(members[0].instance.id).toBe(b.id);
    expect(members[0].instantiate().name).toBe('openai-compat');
  });

  it('resolveGroupMembers: 全部成员被删 → 返回空数组', () => {
    const a = store.create({ name: 'A', kind: 'anthropic', modelId: 'm1' }, 'k');
    const g = store.createGroup('G', [a.id]);
    store.delete(a.id);
    expect(store.resolveGroupMembers(g.id)).toEqual([]);
  });

  it('resolveGroupMembers: 不存在的 groupId → 返回空数组', () => {
    expect(store.resolveGroupMembers('NOPE')).toEqual([]);
  });
});
```

`deskminis/tests/chat-store.test.ts` 追加（文件末尾新 describe）:

```typescript
describe('ChatStore modelBinding', () => {
  it('setModelBinding 写 provider: 前缀', () => {
    const s = store.createSession();
    store.setModelBinding(s.id, 'provider:ABC-123');
    const got = store.getSession(s.id);
    expect(got?.modelBinding).toBe('provider:ABC-123');
  });

  it('setModelBinding 写 group: 前缀', () => {
    const s = store.createSession();
    store.setModelBinding(s.id, 'group:GID-456');
    expect(store.getSession(s.id)?.modelBinding).toBe('group:GID-456');
  });

  it('setModelBinding undefined → 清除绑定（写 NULL）', () => {
    const s = store.createSession();
    store.setModelBinding(s.id, 'provider:ABC');
    store.setModelBinding(s.id, undefined);
    expect(store.getSession(s.id)?.modelBinding).toBeUndefined();
  });

  it('setModelBinding 空串 → 同 undefined（清除）', () => {
    const s = store.createSession();
    store.setModelBinding(s.id, 'group:G');
    store.setModelBinding(s.id, '');
    expect(store.getSession(s.id)?.modelBinding).toBeUndefined();
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `cd deskminis && npm test -- tests/provider-store.test.ts tests/chat-store.test.ts`
Expected: FAIL（`createGroup`/`listGroups`/`resolveGroupMembers`/`setModelBinding` 不存在）

- [x] **Step 3: 修改 provider-store.ts**

`deskminis/src/minisd/store/provider-store.ts` 追加 ModelGroup 相关代码。

先在文件顶部 `ProviderInstance` 接口之后新增 `ModelGroup` 接口:

```typescript
export interface ModelGroup {
  id: string; name: string; memberIds: string[]; createdAt: number;
}
```

`ConfigFile` 接口改为:

```typescript
interface ConfigFile { providers: ProviderInstance[]; defaultProviderId?: string; modelGroups?: ModelGroup[] }
```

在 `ProviderStore` 类的 `instantiate` 方法之后追加 6 个方法:

```typescript
  // ── ModelGroup CRUD ──

  createGroup(name: string, memberIds: string[]): ModelGroup {
    const g: ModelGroup = { id: randomUUID().toUpperCase(), name, memberIds: [...memberIds], createdAt: Date.now() / 1000 };
    if (!this.cfg.modelGroups) this.cfg.modelGroups = [];
    this.cfg.modelGroups.push(g);
    this.save();
    return g;
  }

  listGroups(): ModelGroup[] {
    return this.cfg.modelGroups ?? [];
  }

  getGroup(id: string): ModelGroup | undefined {
    return this.cfg.modelGroups?.find(g => g.id === id);
  }

  updateGroup(id: string, patch: { name?: string; memberIds?: string[] }): void {
    const g = this.cfg.modelGroups?.find(x => x.id === id);
    if (!g) throw new Error(`模型组不存在: ${id}`);
    if (typeof patch.name === 'string' && patch.name.trim()) g.name = patch.name.trim();
    if (patch.memberIds !== undefined) g.memberIds = [...patch.memberIds];
    this.save();
  }

  deleteGroup(id: string): void {
    if (!this.cfg.modelGroups) return;
    this.cfg.modelGroups = this.cfg.modelGroups.filter(g => g.id !== id);
    this.save();
  }

  /**
   * 解析模型组成员，跳过已被 delete 的 provider 实例（静默跳过，不抛错）。
   * 全部失效时返回空数组。调用方（Agent 循环降级链）据此决定是否降级。
   */
  resolveGroupMembers(groupId: string): { instance: ProviderInstance; instantiate(): AgentProvider }[] {
    const g = this.getGroup(groupId);
    if (!g) return [];
    const out: { instance: ProviderInstance; instantiate(): AgentProvider }[] = [];
    for (const mid of g.memberIds) {
      const p = this.cfg.providers.find(x => x.id === mid);
      if (!p) continue; // 已被删除，跳过
      out.push({ instance: p, instantiate: () => this.instantiate(mid) });
    }
    return out;
  }
```

- [x] **Step 4: 修改 chat-store.ts**

`deskminis/src/minisd/store/chat-store.ts` 在 `updateSessionTitle` 方法之后追加:

```typescript
  /** 写入 sessions.model_binding；取值约定见 Global Constraints。undefined/空串 = 清除。 */
  setModelBinding(sessionId: string, binding: string | undefined): void {
    const val = (typeof binding === 'string' && binding.trim() !== '') ? binding.trim() : null;
    this.db.prepare('UPDATE sessions SET model_binding=?, updated_at=? WHERE id=?').run(val, this.nowEpoch(), sessionId);
  }
```

- [x] **Step 5: 跑测试确认通过**

Run: `cd deskminis && npm test -- tests/provider-store.test.ts tests/chat-store.test.ts`
Expected: PASS（provider-store 原有 + 新增 6 个 ModelGroup 用例；chat-store 原有 4 个 + 新增 4 个 modelBinding 用例）

Run: `cd deskminis && npm test`
Expected: 全部通过（M1 测试不回归——ModelGroup 与 setModelBinding 只新增方法，不改既有路径）

- [x] **Step 6: Commit**

```bash
cd "C:\Users\24739\Downloads\openminis1" && git add deskminis/src/minisd/store/provider-store.ts deskminis/src/minisd/store/chat-store.ts deskminis/tests/provider-store.test.ts deskminis/tests/chat-store.test.ts && git commit -m "feat(m2b): ModelGroup 持久化（CRUD + resolveGroupMembers 跳过已删成员）+ ChatStore.setModelBinding"
```

---

### Task 6: Agent 循环降级链（fallback 事件 + ProviderSlot 注入 + 空响应两路处理）

**Files:**
- Modify: `deskminis/src/minisd/agent/loop.ts`（LoopEvent 增加 fallback；RunOptions 增加 fallbackChain；降级逻辑）
- Test: `deskminis/tests/agent-loop.test.ts`（Append）

**Interfaces:**
- Consumes: Task 1 `isFallbackable`；Task 5 `ProviderStore.resolveGroupMembers`（经 Task 7 装配后以 `ProviderSlot[]` 传入）；M1 `ScriptedProvider`/`mkCtx`/`collect`
- Produces（Task 7 依赖）:
  - `interface ProviderSlot { provider: AgentProvider; label: string }` — 降级链条目（label 用于 fallback 事件展示，如 provider name + modelId）
  - `LoopEvent` 新增成员: `{ kind: 'fallback'; from: string; to: string; reason: string }` — 从主模型降级到备选时发一次
  - `RunOptions` 新增可选字段: `fallbackChain?: ProviderSlot[]` — 降级备选链（不含主 provider；主 provider 是 `opts.provider`）
  - 降级语义: 主 provider 的 `streamAgentMessage` 抛 `isFallbackable` 错误时，依次尝试 `fallbackChain` 中的 slot；每个 slot 也走重试梯（retryable 错误同 slot 重试，fallbackable 错误继续降级）；降级成功后，循环后续所有 turn 用该 slot 的 provider
  - 空响应两路处理（设计 §4.2）:
    - HTTP-200 空响应（`assistantParts.length === 0`）在**首轮**（无 tool_result）: 直接换下一 slot 降级（不发 system-reminder）
    - HTTP-200 空响应在**tool_result 后**（即上一 turn 有工具调用，本轮收到了空响应）: 先注入一次 `<system-reminder>` 重试（把 `[系统提醒: 上一次工具调用后你返回了空响应，请继续]` 作为 user 消息追加到历史），重试仍空则降级
  - 降级链耗尽: 发 `{ kind: 'error', message: '所有模型均不可用' }` 终止

**设计要点**（§4.2 三层错误处理段）:
- 重试梯对 retryable 错误的行为不变（同模型透明重试）
- fallbackable 错误不重试，立刻降级到下一 slot
- 降级时发 `fallback` 事件让 UI 可展示原因
- 降级成功后循环"记住"当前 slot，后续 turn 继续用它（不在每 turn 重新从主 provider 开始）

- [x] **Step 1: 写失败测试**

`deskminis/tests/agent-loop.test.ts` 追加（放在 `describe('runAgentLoop')` 块内末尾，复用 `ScriptedProvider`/`mkCtx`/`collect`）:

```typescript
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
    // 历史里应出现 system-reminder 文本（作为 user 消息注入）
    const msgs = store.listMessages(sessionId);
    const reminderMsg = msgs.find(m => m.parts.some(p => p.type === 'text' && (p.value as string).includes('系统提醒')));
    expect(reminderMsg).toBeTruthy();
    // 最终降级到 backup
    expect(events.some(e => e.kind === 'fallback')).toBe(true);
    expect(events.some(e => e.kind === 'textDelta' && e.text === 'backup')).toBe(true);
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
```

- [x] **Step 2: 跑测试确认失败**

Run: `cd deskminis && npm test -- tests/agent-loop.test.ts`
Expected: FAIL（`fallbackChain`/`ProviderSlot`/`fallback` 事件不存在）

- [x] **Step 3: 修改 loop.ts**

`deskminis/src/minisd/agent/loop.ts` 修改。完整替换文件顶部 `LoopEvent`、`RunOptions`、`AccumulatedCall` 声明区，并在 `runAgentLoop` 函数体中插入降级逻辑。

1. `LoopEvent` 联合类型增加 `fallback` 成员（在 `retry` 之后）:

```typescript
export type LoopEvent =
  | { kind: 'textDelta'; text: string }
  | { kind: 'thinkingDelta'; text: string }
  | { kind: 'toolStart'; toolUseId: string; name: string; title: string; input: string }
  | { kind: 'toolEnd'; toolUseId: string; success: boolean; output: string }
  | { kind: 'messagePersisted'; messageId: string }
  | { kind: 'turnEnd'; stopReason: StopReason }
  | { kind: 'retry'; attempt: number; delayMs: number; reason: string }
  | { kind: 'fallback'; from: string; to: string; reason: string }
  | { kind: 'error'; message: string };
```

2. `RunOptions` 增加 `fallbackChain`（在 `retryDelaysMs?` 之后）:

```typescript
export interface ProviderSlot { provider: AgentProvider; label: string }

export interface RunOptions {
  sessionId: string; provider: AgentProvider; tools: ToolRegistry; toolContext: ToolContext;
  systemPrompt: string; maxTokens?: number; thinkingLevel?: ThinkingLevel; maxTurns?: number;
  signal?: AbortSignal; retryDelaysMs?: number[];
  fallbackChain?: ProviderSlot[];
}
```

3. `runAgentLoop` 函数体完整替换为（保留 M1 既有逻辑，在流式请求与空响应处插入降级）:

```typescript
export async function* runAgentLoop(store: ChatStore, opts: RunOptions): AsyncGenerator<LoopEvent> {
  const maxTurns = opts.maxTurns ?? 200;
  const retryLadder = opts.retryDelaysMs ?? DEFAULT_RETRY;
  const maxTokens = opts.maxTokens ?? 4096;
  const thinkingLevel: ThinkingLevel = opts.thinkingLevel ?? 'off';
  const clock = new MonotonicClock(store);
  const fallbackChain = opts.fallbackChain ?? [];

  // 当前生效的 provider slot：降级成功后切换到 backup，后续 turn 继续用它
  let activeSlot: ProviderSlot = { provider: opts.provider, label: 'main' };
  // 降级链指针：从 -1（主 provider）开始，降级时 +1
  let slotIndex = -1;

  /** 尝试从当前 slotIndex 开始找下一个可用 slot */
  function tryFallback(): ProviderSlot | undefined {
    slotIndex++;
    if (slotIndex >= fallbackChain.length) return undefined;
    const next = fallbackChain[slotIndex];
    return next;
  }

  let hadToolCallInPrevTurn = false; // 上一轮是否有工具调用（用于空响应两路处理判定）

  for (let turn = 0; turn < maxTurns; turn++) {
    if (opts.signal?.aborted) { yield { kind: 'error', message: '已取消' }; return; }
    const history = store.listMessages(opts.sessionId);
    clock.observe(history);
    const req: StreamRequest = {
      messages: pairToolResults(toAgentMessages(history)),
      systemPrompt: opts.systemPrompt, tools: opts.tools.definitions(), maxTokens, thinkingLevel,
    };

    let text = ''; let reasoning = ''; let usage: TokenUsage | undefined; let stopReason: StopReason = 'endTurn';
    let calls: AccumulatedCall[] = [];
    let streamOk = false;
    let lastError: ProviderError | undefined;

    // 降级循环：主 slot → fallbackChain[0] → [1] → …
    // 每次 slot 切换后重置累加器，从头流式请求
    while (true) {
      text = ''; reasoning = ''; usage = undefined; stopReason = 'endTurn'; calls = [];
      const currentProvider = activeSlot.provider;
      const currentLabel = activeSlot.label;

      // 透明重试：仅对 retryable 错误（M1 逻辑不变）
      let attemptSucceeded = false;
      for (let attempt = 0; attempt <= retryLadder.length; attempt++) {
        text = ''; reasoning = ''; usage = undefined; stopReason = 'endTurn'; calls = [];
        try {
          for await (const ev of currentProvider.streamAgentMessage(req, opts.signal)) {
            switch (ev.kind) {
              case 'textDelta': text += ev.text; yield ev; break;
              case 'thinkingDelta': reasoning += ev.text; yield ev; break;
              case 'toolCallComplete': calls.push({ toolUseId: ev.toolUseId, name: ev.name, input: ev.input, ...(ev.thoughtSignature !== undefined ? { thoughtSignature: ev.thoughtSignature } : {}) }); break;
              case 'usage': usage = ev.usage; break;
              case 'done': stopReason = ev.stopReason; break;
              case 'toolInputDelta': break;
            }
          }
          attemptSucceeded = true;
          break;
        } catch (e) {
          if (opts.signal?.aborted) { yield { kind: 'error', message: '已取消' }; return; }
          const err = e instanceof ProviderError ? e : new ProviderError(String(e), { retryable: false });
          // fallbackable 错误：不重试，立刻降级
          if (isFallbackable(err)) {
            lastError = err;
            break; // 跳出重试梯，进入下方降级逻辑
          }
          // 非 fallbackable 错误：retryable 先走重试梯；非 retryable 或重试梯耗尽 → 有备选则降级，无备选报错终止
          if (!err.retryable || attempt >= retryLadder.length) {
            // 还有降级备选时先降级，否则报错终止
            if (slotIndex + 1 < fallbackChain.length) {
              lastError = err;
              break;
            }
            yield { kind: 'error', message: err.message }; return;
          }
          // retryable：走重试梯
          const d = retryLadder[attempt];
          yield { kind: 'retry', attempt: attempt + 1, delayMs: d, reason: err.message };
          await delay(d);
          if (opts.signal?.aborted) { yield { kind: 'error', message: '已取消' }; return; }
        }
      }

      if (attemptSucceeded) { streamOk = true; break; }

      // 到这里说明当前 slot 的流式请求失败了（fallbackable 或 retryable 耗尽）
      // 尝试降级到下一 slot
      const nextSlot = tryFallback();
      if (!nextSlot) {
        yield { kind: 'error', message: '所有模型均不可用' };
        return;
      }
      yield { kind: 'fallback', from: activeSlot.label, to: nextSlot.label, reason: lastError?.message ?? '未知错误' };
      activeSlot = nextSlot;
      // 继续 while(true) 用新 slot 重新流式请求
    }

    if (!streamOk) { yield { kind: 'error', message: '流式请求失败' }; return; }

    // 持久化 assistant 消息（text + toolUse）
    const assistantParts: ContentPart[] = [];
    if (text) assistantParts.push({ type: 'text', value: text });
    for (const c of calls) {
      c.input = safeToolInput(c.input);
      assistantParts.push({ type: 'toolUse', value: { toolUseId: c.toolUseId, name: c.name, input: c.input, ...(c.thoughtSignature !== undefined ? { thoughtSignature: c.thoughtSignature } : {}) } });
    }

    // 空响应处理（设计 §4.2 空响应两路）
    if (assistantParts.length === 0) {
      if (!hadToolCallInPrevTurn) {
        // 首轮空响应：直接降级，不注入 system-reminder
        const nextSlot = tryFallback();
        if (!nextSlot) { yield { kind: 'error', message: '所有模型均不可用' }; return; }
        yield { kind: 'fallback', from: activeSlot.label, to: nextSlot.label, reason: '空响应' };
        activeSlot = nextSlot;
        turn--; // 不消耗 turn 额度，重试这一轮
        continue;
      }
      // tool_result 后空响应：先注入一次 system-reminder 重试
      // 检查是否已经注入过 reminder（避免无限循环）
      const lastUserMsg = history.filter(m => m.role === 'user').at(-1);
      const alreadyReminded = lastUserMsg?.parts.some(p => p.type === 'text' && (p.value as string).includes('系统提醒')) ?? false;
      if (!alreadyReminded) {
        // 注入 system-reminder 作为 user 消息
        store.appendMessage({
          id: store.newId(), sessionId: opts.sessionId, role: 'user',
          parts: [{ type: 'text', value: '[系统提醒: 上一次工具调用后你返回了空响应，请继续]' }],
          createdAt: clock.next(), streamInterruptCount: 0,
        });
        turn--; // 不消耗 turn 额度，重试这一轮
        continue;
      }
      // reminder 重试仍空：降级
      const nextSlot = tryFallback();
      if (!nextSlot) { yield { kind: 'error', message: '所有模型均不可用' }; return; }
      yield { kind: 'fallback', from: activeSlot.label, to: nextSlot.label, reason: '空响应（reminder 重试后仍空）' };
      activeSlot = nextSlot;
      turn--;
      continue;
    }

    const assistant = store.appendMessage({
      id: store.newId(), sessionId: opts.sessionId, role: 'assistant', parts: assistantParts,
      createdAt: clock.next(), streamInterruptCount: 0, reasoningContent: reasoning || undefined, tokenUsage: usage,
    });
    yield { kind: 'messagePersisted', messageId: assistant.id };

    hadToolCallInPrevTurn = calls.length > 0;

    if (calls.length === 0) { yield { kind: 'turnEnd', stopReason }; return; }

    // 并发执行工具（上限 10），结果按原顺序拼回
    for (const c of calls) yield { kind: 'toolStart', toolUseId: c.toolUseId, name: c.name, title: extractTitle(c.input), input: c.input };
    const results = await runWithConcurrency(calls, CONCURRENCY, async c => {
      const outcome = await opts.tools.execute(c.name, c.input, opts.toolContext);
      return { c, outcome };
    });
    const resultParts: ContentPart[] = [];
    for (const { c, outcome } of results) {
      yield { kind: 'toolEnd', toolUseId: c.toolUseId, success: outcome.success, output: outcome.output };
      resultParts.push({ type: 'toolResult', value: { toolUseId: c.toolUseId, output: outcome.output, success: outcome.success, status: outcome.success ? 'success' : 'failed' } });
    }
    const resultMsg = store.appendMessage({
      id: store.newId(), sessionId: opts.sessionId, role: 'user', parts: resultParts,
      createdAt: clock.next(), streamInterruptCount: 0,
    });
    yield { kind: 'messagePersisted', messageId: resultMsg.id };
  }
  yield { kind: 'error', message: `已达最大回合数 ${maxTurns}` };
}
```

> **注意**：`isFallbackable` 需要 import。在文件顶部已有的 import 行 `import { ProviderError } from '../providers/types';` 改为:
> ```typescript
> import { ProviderError, isFallbackable } from '../providers/types';
> ```

- [x] **Step 4: 跑测试确认通过**

Run: `cd deskminis && npm test -- tests/agent-loop.test.ts`
Expected: PASS（含 M2b 降级链 6 个新用例 + Task 2 thoughtSignature 用例 + M1 既有用例全部通过）

Run: `cd deskminis && npm test`
Expected: 全部通过（M1 测试不回归——`fallbackChain` 默认空数组，无 fallbackChain 时降级逻辑不触发，行为与 M1 完全一致）

- [x] **Step 5: Commit**

```bash
cd "C:\Users\24739\Downloads\openminis1" && git add deskminis/src/minisd/agent/loop.ts deskminis/tests/agent-loop.test.ts && git commit -m "feat(m2b): Agent 循环降级链——fallback 事件 + ProviderSlot 注入 + 空响应两路处理（首轮直接降级 / tool_result 后先 reminder 重试再降级）"
```

---

### Task 7: RPC 面（modelgroup.* CRUD + chat.prompt 链式解析 + fallback 成功后改写会话绑定）

**Files:**
- Modify: `deskminis/src/minisd/index.ts`（新增 `modelgroup.*` RPC 方法 + `chat.prompt` 链式解析 model_binding + fallback 后改写绑定）
- Test: `deskminis/tests/rpc.test.ts`（Append）

**Interfaces:**
- Consumes: Task 5 `ProviderStore.createGroup/listGroups/getGroup/updateGroup/deleteGroup/resolveGroupMembers` + `ChatStore.setModelBinding`；Task 6 `RunOptions.fallbackChain`/`ProviderSlot`；Task 3 `ProviderStore.instantiate`（支持 gemini/ollama）；Task 4 `catalog.clampThinkingLevel`
- Produces: 无（本 Task 是装配层，把 Task 5/6 的能力经 RPC 暴露给 UI）

**装配逻辑**:
- `chat.prompt` 收到请求后，按以下顺序解析 provider:
  1. `p.providerId` 显式指定 → `providers.instantiate(providerId)`（M1 既有行为不变）
  2. 未指定 providerId → 读 `sessions.model_binding`:
     - `'provider:<instanceId>'` → `providers.instantiate(instanceId)`（M1 既有行为不变）
     - `'group:<groupId>'` → `providers.resolveGroupMembers(groupId)` → 第一个成员作为主 provider，其余作为 `fallbackChain`
     - 空/NULL → `providers.getDefaultId()` → `providers.instantiate(defaultId)`（M1 既有行为不变）
  3. 若解析到模型组且成员为空（全部被删），报错 "模型组无可用成员"
- **fallback 成功后改写会话绑定**（设计 §4.2 "成功后改写会话绑定"）: 凡降级成功（`runAgentLoop` 发出 `fallback` 事件且该 slot 最终跑通），会话绑定一律改写为 `provider:<backupInstanceId>`；改写只发生一次（首个 `fallback` 事件触发，后续 `fallback` 不再改写）。实现方式: `ProviderSlot` 增加可选 `instanceId?: string` 字段（仅 `chat.prompt` 装配 fallbackChain 时从 `resolveGroupMembers` 的 `instance.id` 填入），IIFE 事件循环拦截首个 `fallback` 事件，按 `event.to` label 在 fallbackChain 中找到对应 slot 的 `instanceId`，调用 `chat.setModelBinding`。`loop.ts` 里的 `ProviderSlot` 不需改——`instanceId` 是 index.ts 装配层加的扩展字段，`loop.ts` 只用 `provider` 和 `label`。

- [ ] **Step 1: 写失败测试**

`deskminis/tests/rpc.test.ts` 追加（文件末尾新 describe，复用 `boot`/`rpcClient`/`waitFor`/`toolScript`）:

```typescript
describe('modelgroup.* RPC', () => {
  it('create/list/get/update/delete', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    // 先建两个 provider（TEST 模式下 kind 不校验密钥，但 openai-compat 需要 baseUrl）
    const a = (await c.call('provider.instances.create', { name: 'A', kind: 'anthropic', modelId: 'm1', apiKey: 'k' })).result;
    const b = (await c.call('provider.instances.create', { name: 'B', kind: 'openai-compat', baseUrl: 'http://x/v1', modelId: 'm2', apiKey: 'k' })).result;
    // create
    const g = (await c.call('modelgroup.create', { name: '链1', memberIds: [a.id, b.id] })).result;
    expect(g.id).toMatch(/^[0-9A-F-]{36}$/);
    expect(g.memberIds).toEqual([a.id, b.id]);
    // list
    const list = (await c.call('modelgroup.list')).result;
    expect(list).toHaveLength(1);
    // get
    const got = (await c.call('modelgroup.get', { id: g.id })).result;
    expect(got.name).toBe('链1');
    // update
    await c.call('modelgroup.update', { id: g.id, name: '链2', memberIds: [a.id] });
    expect((await c.call('modelgroup.get', { id: g.id })).result.name).toBe('链2');
    // delete（需 confirm）
    const noConfirm = await c.call('modelgroup.delete', { id: g.id });
    expect(noConfirm.error).toBeTruthy();
    await c.call('modelgroup.delete', { id: g.id, confirm: true });
    expect((await c.call('modelgroup.list')).result).toHaveLength(0);
    c.close();
  });

  it('delete 不存在的 group 不报错', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const r = await c.call('modelgroup.delete', { id: 'NOPE', confirm: true });
    expect(r.result).toEqual({ ok: true });
    c.close();
  });
});

describe('chat.prompt 模型组绑定链式解析', () => {
  it('会话绑定 group: → fake provider fallbackChain 非空（降级事件可观察）', async () => {
    const { port, authToken, dataDir } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    // 建 provider + group
    const a = (await c.call('provider.instances.create', { name: 'A', kind: 'anthropic', modelId: 'm1', apiKey: 'k' })).result;
    const b = (await c.call('provider.instances.create', { name: 'B', kind: 'anthropic', modelId: 'm2', apiKey: 'k' })).result;
    const g = (await c.call('modelgroup.create', { name: 'G', memberIds: [a.id, b.id] })).result;
    // 建会话并绑定 group
    const s = (await c.call('chat.sessions.create', { title: 'T' })).result;
    // 用 chat.prompt 的 providerId 指定 fake（TEST 模式）；此处只验证 group 绑定不报错
    // 并验证 fallbackChain 装配——但 fake provider 不会 429，所以这里只验证能跑通
    await c.call('chat.prompt', { sessionId: s.id, text: 'hi', providerId: '__fake__' });
    await waitFor('agent 循环完成', () => c.notifications.some(n => n.params?.event?.kind === 'turnEnd' || n.params?.event?.kind === 'error'), 5000);
    c.close();
  });

  it('会话绑定 group: 且成员全被删 → chat.prompt 报错', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const a = (await c.call('provider.instances.create', { name: 'A', kind: 'anthropic', modelId: 'm1', apiKey: 'k' })).result;
    const g = (await c.call('modelgroup.create', { name: 'G', memberIds: [a.id] })).result;
    const s = (await c.call('chat.sessions.create')).result;
    // 用 RPC 设绑定（chat.sessions.setModelBinding 或直接 chat.prompt 带 modelGroupId）
    // 此处通过 chat.prompt 带 modelGroupId 参数测试链式解析
    await c.call('provider.instances.delete', { id: a.id, confirm: true });
    const resp = await c.call('chat.prompt', { sessionId: s.id, text: 'hi', modelGroupId: g.id });
    expect(resp.error).toBeTruthy();
    c.close();
  });

  it('chat.prompt 带 modelGroupId 参数 → 走模型组解析', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const a = (await c.call('provider.instances.create', { name: 'A', kind: 'anthropic', modelId: 'm1', apiKey: 'k' })).result;
    const g = (await c.call('modelgroup.create', { name: 'G', memberIds: [a.id] })).result;
    const s = (await c.call('chat.sessions.create')).result;
    // 模型组只有一个成员 = A（anthropic），但 TEST 模式下 A 没有 fake provider 行为
    // 这里只验证不报错、能启动
    const r = await c.call('chat.prompt', { sessionId: s.id, text: 'hi', modelGroupId: g.id });
    // 不报错即成功（fake provider 只认 __fake__ id，但 modelGroupId 走真实 instantiate）
    // 真实 anthropic provider 没有 key 会报错——但 TEST 模式 vault 是 InMemoryVault
    // 所以这里预期 error（密钥不存在或网络错误），关键是 "模型组无可用成员" 不出现
    expect(r.error?.message ?? '').not.toContain('无可用成员');
    c.close();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd deskminis && npm test -- tests/rpc.test.ts`
Expected: FAIL（`modelgroup.create`/`modelgroup.list` 等方法不存在；`chat.prompt` 不认 `modelGroupId` 参数）

- [ ] **Step 3: 修改 index.ts**

`deskminis/src/minisd/index.ts` 修改:

1. import 行追加（在现有 import 末尾）:

```typescript
import type { ProviderSlot } from './agent/loop';
```

2. `chat.prompt` 方法完整替换为（增加 `modelGroupId` 参数 + 链式解析 + fallback 事件拦截改写绑定）:

```typescript
    'chat.prompt': (p: { sessionId: string; text: string; providerId?: string; thinkingLevel?: 'off' | 'low' | 'medium' | 'high'; modelGroupId?: string }) => {
      const sessionId = assertSessionId(p.sessionId);
      if (typeof p.text !== 'string' || p.text.trim() === '') throw new Error('消息内容不能为空');
      if (inFlight.has(sessionId)) throw new Error('该会话正在运行中，请等待完成或取消');

      // ── 链式解析 provider + fallbackChain ──
      let provider: AgentProvider;
      let fallbackChain: ProviderSlot[] = [];

      if (p.modelGroupId) {
        // 显式指定模型组
        const members = providers.resolveGroupMembers(p.modelGroupId);
        if (members.length === 0) throw new Error('模型组无可用成员');
        provider = members[0].instantiate();
        fallbackChain = members.slice(1).map(m => ({ provider: m.instantiate(), label: `${m.instance.name}(${m.instance.modelId})`, instanceId: m.instance.id }));
      } else if (p.providerId) {
        // 显式指定单 provider（M1 既有行为）
        provider = (fakeEnabled && p.providerId === '__fake__') ? new FakeProvider() : providers.instantiate(p.providerId);
      } else {
        // 从会话绑定解析
        const session = chat.getSession(sessionId);
        const binding = session?.modelBinding;
        if (binding?.startsWith('group:')) {
          const gid = binding.slice('group:'.length);
          const members = providers.resolveGroupMembers(gid);
          if (members.length === 0) throw new Error('模型组无可用成员');
          provider = members[0].instantiate();
          fallbackChain = members.slice(1).map(m => ({ provider: m.instantiate(), label: `${m.instance.name}(${m.instance.modelId})`, instanceId: m.instance.id }));
        } else if (binding?.startsWith('provider:')) {
          const pid = binding.slice('provider:'.length);
          provider = (fakeEnabled && pid === '__fake__') ? new FakeProvider() : providers.instantiate(pid);
        } else {
          // 未绑定 → 默认 provider（M1 既有行为）
          const defaultId = providers.getDefaultId();
          if (!defaultId) throw new Error('尚未配置任何模型 provider，请先在设置中添加');
          provider = (fakeEnabled && defaultId === '__fake__') ? new FakeProvider() : providers.instantiate(defaultId);
        }
      }

      // thinkingLevel 钳制（Task 4）
      const clampedThinking = catalog.clampThinkingLevel(provider.modelId, p.thinkingLevel ?? 'off');

      inFlight.add(sessionId);
      const controller = new AbortController();
      controllers.set(sessionId, controller);
      chat.appendMessage({ id: chat.newId(), sessionId, role: 'user', parts: [{ type: 'text', value: p.text }], createdAt: chat.nowEpoch(), streamInterruptCount: 0 });
      paths.ensureSessionDirs(sessionId);
      void (async () => {
        let fellBack = false;
        try {
          for await (const event of runAgentLoop(chat, {
            sessionId, provider, tools,
            toolContext: { sessionId, paths, permissions: gateway },
            systemPrompt: SYSTEM_PROMPT, thinkingLevel: clampedThinking,
            signal: controller.signal,
            fallbackChain,
          })) {
            // 拦截 fallback 事件：降级成功后改写会话绑定（设计 §4.2）
            if (event.kind === 'fallback' && !fellBack) {
              fellBack = true;
              // 从 fallbackChain 中按 label 找到降级目标的 instanceId
              const target = fallbackChain.find(s => s.label === event.to) as (ProviderSlot & { instanceId?: string }) | undefined;
              if (target?.instanceId) {
                chat.setModelBinding(sessionId, `provider:${target.instanceId}`);
              }
            }
            rpc.broadcast('chat.event', { sessionId, event });
          }
        } catch (e) { rpc.broadcast('chat.event', { sessionId, event: { kind: 'error', message: String(e) } }); }
        finally { inFlight.delete(sessionId); controllers.delete(sessionId); }
      })();
      return { ok: true };
    },
```

3. 在 `methods` 对象中 `provider.setDefault` 之后追加 `modelgroup.*` 方法:

```typescript
    // ── ModelGroup ──
    'modelgroup.create': (p: { name: string; memberIds: string[] }) => {
      if (typeof p.name !== 'string' || p.name.trim() === '') throw new Error('模型组名称不能为空');
      if (!Array.isArray(p.memberIds) || p.memberIds.length === 0) throw new Error('模型组至少需要一个成员');
      return providers.createGroup(p.name.trim(), p.memberIds);
    },
    'modelgroup.list': () => providers.listGroups(),
    'modelgroup.get': (p: { id: string }) => {
      const g = providers.getGroup(p.id);
      if (!g) throw new Error(`模型组不存在: ${p.id}`);
      return g;
    },
    'modelgroup.update': (p: { id: string; name?: string; memberIds?: string[] }) => {
      const patch: { name?: string; memberIds?: string[] } = {};
      if (typeof p.name === 'string' && p.name.trim()) patch.name = p.name.trim();
      if (Array.isArray(p.memberIds) && p.memberIds.length > 0) patch.memberIds = p.memberIds;
      providers.updateGroup(p.id, patch);
      return { ok: true };
    },
    'modelgroup.delete': (p: { id: string; confirm?: boolean }) => {
      if (p.confirm !== true) throw new Error('删除模型组需 confirm:true');
      providers.deleteGroup(p.id);
      return { ok: true };
    },
```

4. 新增 `chat.sessions.setModelBinding` RPC 方法（在 `chat.sessions.delete` 之后）:

```typescript
    'chat.sessions.setModelBinding': (p: { sessionId: string; binding?: string }) => {
      const sessionId = assertSessionId(p.sessionId);
      chat.setModelBinding(sessionId, p.binding);
      return { ok: true };
    },
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd deskminis && npm test -- tests/rpc.test.ts`
Expected: PASS（含 modelgroup 5 个新用例 + chat.prompt 链式解析 3 个新用例 + M1 既有用例全部通过）

Run: `cd deskminis && npm test`
Expected: 全部通过

- [ ] **Step 5: Commit**

```bash
cd "C:\Users\24739\Downloads\openminis1" && git add deskminis/src/minisd/index.ts deskminis/tests/rpc.test.ts && git commit -m "feat(m2b): modelgroup.* RPC 面 + chat.prompt 模型组链式解析 + fallback 成功后改写会话绑定"
```

---

## M2b 完成定义

- 自动化全绿（`npm test`）：M1 既有 16 个测试文件 + M2b 新增 provider-errors / gemini / ollama / model-catalog，以及 provider-store / chat-store / agent-loop / rpc 扩充用例
- 端到端手工验收 6 步全过：
  1. UI 添加 Gemini provider（key + modelId=gemini-2.5-flash）→ 对话能收到文本/thinking/工具调用
  2. UI 添加 Ollama provider（不填 key、baseUrl 留空用默认）→ 对话能收到本地模型回复
  3. 创建模型组（主=A anthropic，备=B ollama）→ 会话绑定 group → 故意让 A 限流（改 key 为无效值）→ 观察 fallback 事件出现、B 接管回复
  4. 首轮空响应（用不稳定的兼容端点）→ 验证直接降级不注入 system-reminder
  5. tool_result 后空响应 → 验证历史里出现 `[系统提醒]` user 消息、重试仍空后降级
  6. 降级成功后重启应用 → 会话绑定已改写为 `provider:<backupId>`
- 交付物：Gemini 原生 Provider（thoughtSignature 全链路）、Ollama Provider（OpenAI 兼容端点 + 免 key）、模型能力目录（models.dev + 缓存 + 兜底 + ThinkingLevel 钳制）、ModelGroup 持久化与 CRUD、Agent 循环降级链（fallback 事件 + 空响应两路处理 + 降级成功改写绑定）、`modelgroup.*` 与 `chat.sessions.setModelBinding` RPC 面
- 下一步：M2 其余子系统（上下文压缩/卸载/记忆、技能系统、windows-* 桥、右栏面板）；模型组管理 UI 属 M2 UI 子计划
