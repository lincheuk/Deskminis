/**
 * F01R：F01 独立复核确认的缺陷在解析器、请求计划与三个请求构建器上的回归（循环与端到端的在 runtime-model-loop / runtime-model-e2e）。
 * 目录用真 ModelCatalog：夹具（catalogFixture / catalogFixtureF01R）与真实 models.dev 快照的摘录（snapshotExcerpt），不联网。
 * 每条都断到「实际会发出去的请求体」这一层：只看 resolver 的字段，测不出「字段对了、请求没跟着变」。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelCatalog } from '../src/minisd/providers/model-catalog';
import { describeEndpoint, planSlot, resolveRuntimeModel, type RuntimeModelInput, type SlotPlan } from '../src/minisd/providers/runtime-model';
import { buildOpenAIBody } from '../src/minisd/providers/openai';
import { buildAnthropicBody } from '../src/minisd/providers/anthropic';
import { buildGeminiBody } from '../src/minisd/providers/gemini';
import type { StreamRequest } from '../src/minisd/providers/types';
import { flattenToolHistory } from '../src/minisd/agent/loop';
import { FALLBACK_CONTEXT_WINDOW, outputCeiling, type RuntimeModel } from '../src/shared/runtime-model';
import type { AgentMessage, ThinkingLevel } from '../src/shared/types';
import { catalogFixture, catalogFixtureF01R, jsonResponse } from './runtime-model-fixture';
import { snapshotExcerpt } from './runtime-model-snapshot-fixture';

let dir: string;
/** 夹具目录（catalogFixtureF01R）与真实快照摘录。 */
let fixture: ModelCatalog;
let excerpt: ModelCatalog;
let seq = 0;
async function catalogOf(data: unknown): Promise<ModelCatalog> {
  const c = new ModelCatalog(join(dir, `catalog-${seq++}.json`), async () => jsonResponse(data));
  expect(await c.refresh(true)).toBe(true);
  return c;
}
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dm-runtime-review-'));
  fixture = await catalogOf(catalogFixtureF01R());
  excerpt = await catalogOf(snapshotExcerpt());
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const RELAY = 'https://relay.example/v1';
const oa = (baseUrl: string, modelId: string, extra: Partial<RuntimeModelInput> = {}): RuntimeModelInput => ({ kind: 'openai-compat', baseUrl, modelId, ...extra });
const NO_NEEDS = { currentImages: 0, historyImages: 0 };
const ONE_IMAGE = { currentImages: 1, historyImages: 0 };
const TOOL = { name: 'echo', description: 'echo', parameters: { text: { type: 'string' as const, description: 't' } }, required: ['text'] };
const HELLO: AgentMessage[] = [{ role: 'user', parts: [{ type: 'text', value: 'hi' }] }];

/** 把请求计划变成 StreamRequest，写法与 loop.ts 组 slotReq 的那一段相同。 */
function reqOf(plan: SlotPlan, messages: AgentMessage[] = HELLO): StreamRequest {
  return {
    messages, systemPrompt: 'sys', maxTokens: plan.maxTokens, tools: plan.sendTools ? [TOOL] : [], thinkingLevel: plan.thinking.level,
    ...(plan.thinking.level !== 'off' && (plan.thinking.effort !== undefined || plan.thinking.budgetTokens !== undefined)
      ? { thinking: { ...(plan.thinking.effort !== undefined ? { effort: plan.thinking.effort } : {}), ...(plan.thinking.budgetTokens !== undefined ? { budgetTokens: plan.thinking.budgetTokens } : {}) } }
      : {}),
  };
}
/** 按协议取实际写进请求体的输出上限。 */
function sentMaxTokens(rt: RuntimeModel, plan: SlotPlan): number {
  if (rt.protocol === 'anthropic') return buildAnthropicBody(reqOf(plan), rt.modelId).max_tokens as number;
  if (rt.protocol === 'gemini') return (buildGeminiBody(reqOf(plan), rt.modelId).generationConfig as { maxOutputTokens: number }).maxOutputTokens;
  return buildOpenAIBody(reqOf(plan), rt.modelId).max_tokens as number;
}
const planOf = (rt: RuntimeModel, level: ThinkingLevel = 'off', needs = NO_NEEDS): SlotPlan => planSlot(rt, level, needs, '槽');

describe('R1 输出上限：目录里的占位写法不采用（A1/B2/D1，真实快照摘录）', () => {
  type Row = { input: RuntimeModelInput; window: number; limit: Record<string, unknown>; request: number; note?: string };
  const rows = (): Row[] => [
    // 端点记录 output == context：退到跨服务商佐证值
    { input: oa('https://api.moonshot.cn/v1', 'kimi-k3'), window: 1_048_576, limit: { value: 65_536, source: 'aggregate', declared: 1_048_576 }, request: 65_536, note: '不小于上下文窗口' },
    { input: oa('https://api.moonshot.cn/v1', 'kimi-k2.6'), window: 262_144, limit: { value: 65_536, source: 'aggregate', declared: 262_144 }, request: 65_536, note: '不小于上下文窗口' },
    { input: oa('https://api.siliconflow.cn/v1', 'deepseek-ai/DeepSeek-V3'), window: 164_000, limit: { value: 8_192, source: 'aggregate', declared: 164_000 }, request: 8_192, note: '未采用' },
    { input: oa('https://api.siliconflow.cn/v1', 'Qwen/Qwen3-32B'), window: 131_000, limit: { value: 8_192, source: 'aggregate', declared: 131_000 }, request: 8_192, note: '未采用' },
    // 端点记录是 0.9 × 窗口的占位值，佐证值可信
    { input: oa('https://openrouter.ai/api/v1', 'z-ai/glm-5.2'), window: 1_048_576, limit: { value: 128_000, source: 'aggregate', declared: 943_718 }, request: 128_000, note: '超过上下文窗口的 3/4' },
    // 输出 > 窗口，佐证值（32768）等于窗口：都不可信 → 8192
    { input: oa('https://api.302.ai/v1', 'gemini-3-pro-image-preview'), window: 32_768, limit: { source: 'none', declared: 64_000 }, request: 8_192, note: '没有可采用的佐证值' },
    // 0.9 / 0.8 占位值本身被两家「佐证」：不采用
    { input: oa('https://openrouter.ai/api/v1', 'moonshotai/kimi-k2.6'), window: 262_144, limit: { source: 'none', declared: 235_929 }, request: 8_192, note: '超过上下文窗口的 3/4' },
    { input: oa('https://api.kilo.ai/api/gateway', 'mistralai/mistral-large-2512'), window: 262_144, limit: { source: 'none', declared: 209_715 }, request: 8_192, note: '超过上下文窗口的 3/4' },
    // 边界代价：0.768 的真实规格落到 8192（可手动填写）
    { input: oa('https://nano-gpt.com/api/v1', 'z-ai/GLM-4.5-Air'), window: 128_000, limit: { source: 'none', declared: 98_304 }, request: 8_192, note: '手动填写最大输出' },
  ];
  const kept = (): Row[] => [
    // 恰为 3/4：含边界，采用
    { input: oa('https://api.z.ai/api/paas/v4', 'glm-4.5'), window: 131_072, limit: { value: 98_304, source: 'endpoint' }, request: 98_304 },
    { input: oa('https://api.z.ai/api/paas/v4', 'glm-4.6'), window: 204_800, limit: { value: 131_072, source: 'endpoint' }, request: 131_072 },
    { input: oa('https://opencode.ai/zen/v1', 'glm-4.6'), window: 204_800, limit: { value: 131_072, source: 'endpoint' }, request: 131_072 },
    { input: { kind: 'anthropic', modelId: 'claude-sonnet-4-6' }, window: 200_000, limit: { value: 128_000, source: 'endpoint' }, request: 128_000 },
    { input: { kind: 'anthropic', modelId: 'claude-opus-4-8' }, window: 200_000, limit: { value: 128_000, source: 'endpoint' }, request: 128_000 },
    { input: { kind: 'anthropic', modelId: 'claude-haiku-4-5' }, window: 200_000, limit: { value: 64_000, source: 'endpoint' }, request: 64_000 },
    { input: oa('https://api.openai.com/v1', 'gpt-5-pro'), window: 400_000, limit: { value: 272_000, source: 'endpoint' }, request: 272_000 },
    { input: oa('https://api.openai.com/v1', 'gpt-3.5-turbo'), window: 16_385, limit: { value: 4_096, source: 'endpoint' }, request: 4_096 },
    { input: oa('https://api.deepseek.com', 'deepseek-v4-pro'), window: 1_000_000, limit: { value: 393_216, source: 'endpoint' }, request: 393_216 },
  ];

  it('output ≥ 窗口或超过窗口 3/4 的目录值不发出去：退到可信的佐证值，再退到 8192；规格里留下目录原值与原因', () => {
    for (const row of rows()) {
      const rt = resolveRuntimeModel(row.input, excerpt);
      const where = `${row.input.baseUrl} ${row.input.modelId}`;
      expect(rt.limits.contextWindow.value, where).toBe(row.window);
      expect(rt.limits.maxOutputTokens, where).toMatchObject(row.limit);
      if (!('value' in row.limit)) expect(rt.limits.maxOutputTokens.value, where).toBeUndefined();
      expect(rt.limits.maxOutputTokens.note, where).toContain('未采用');
      expect(rt.limits.maxOutputTokens.note, where).toContain(row.note!);
      expect(rt.requestMaxTokens, where).toBe(row.request);
      const sent = buildOpenAIBody(reqOf(planOf(rt)), rt.modelId).max_tokens as number;
      expect(sent, where).toBe(row.request);
      expect(sent, where).toBeLessThan(row.window);
    }
  });

  it('可信的端点记录（≤ 窗口的 3/4，含恰为 3/4）原样采用：各服务商仍各取各的，不取跨服务商最小值', () => {
    for (const row of kept()) {
      const rt = resolveRuntimeModel(row.input, excerpt);
      const where = `${row.input.kind} ${row.input.baseUrl ?? ''} ${row.input.modelId}`;
      expect(rt.limits.contextWindow.value, where).toBe(row.window);
      expect(rt.limits.maxOutputTokens, where).toEqual(row.limit);
      expect(rt.requestMaxTokens, where).toBe(row.request);
      expect(sentMaxTokens(rt, planOf(rt)), where).toBe(row.request);
    }
    // gpt-5-pro 的佐证最小值是 128000：取 min 的做法会把 272000 压下去，这里钉住没有这么做
    expect(resolveRuntimeModel(oa(RELAY, 'gpt-5-pro'), excerpt).requestMaxTokens).toBeLessThan(272_000);
  });

  it('中转没有端点记录：佐证值同样要过合理性检查', () => {
    const k3 = resolveRuntimeModel(oa(RELAY, 'kimi-k3'), excerpt);
    expect(k3.limits.maxOutputTokens).toEqual({ value: 65_536, source: 'aggregate' });
    expect(k3.requestMaxTokens).toBe(65_536);
    const placeholder = resolveRuntimeModel(oa(RELAY, 'moonshotai/kimi-k2.6'), excerpt);
    expect(placeholder.limits.maxOutputTokens).toMatchObject({ source: 'none', declared: 235_929 });
    expect(placeholder.requestMaxTokens).toBe(8_192);
  });
});

describe('R2 输出上限：手动值不受检查；按生效窗口（含手动窗口）判断；小窗口兜底不超过窗口的 3/4', () => {
  it('手动填的最大输出原样发送，哪怕比窗口还大', () => {
    const rt = resolveRuntimeModel(oa('https://api.moonshot.cn/v1', 'kimi-k2.6', { maxOutputTokens: 300_000 }), excerpt);
    expect(rt.limits.maxOutputTokens).toEqual({ value: 300_000, source: 'manual', declared: 262_144 });
    expect(rt.requestMaxTokens).toBe(300_000);
    expect(buildOpenAIBody(reqOf(planOf(rt)), rt.modelId).max_tokens).toBe(300_000);
  });

  // F02（主会话裁决 2）：F01R 时这里退到佐证值 8000。逐请求预算让「取 min(目录值, 手动窗口的 3/4)」变得安全后，
  // 被手动窗口挤掉的端点记录（按目录自己的 200000 窗口，32000 是可信的）按手动窗口的 3/4 封顶后采用
  it('手动把窗口改小：按改后的窗口判，端点记录 32000 放不下，按手动窗口的 3/4（24000）封顶后采用', () => {
    const rt = resolveRuntimeModel(oa('https://api.vendor-a.example/v1', 'shared-model', { contextWindow: 32_000 }), fixture);
    expect(rt.limits.maxOutputTokens).toMatchObject({ value: 24_000, source: 'endpoint', declared: 32_000 });
    expect(rt.limits.maxOutputTokens.note).toContain('窗口 32000');
    expect(rt.limits.maxOutputTokens.note).toContain('输出上限按窗口的 3/4（24000）计');
    expect(rt.requestMaxTokens).toBe(24_000);
  });

  it('没有输出上限资料、窗口又很小：兜底值按窗口的 3/4 封顶并说明', () => {
    const bare = resolveRuntimeModel(oa(RELAY, 'bare-model', { contextWindow: 8_000 }), fixture);
    expect(bare.limits.maxOutputTokens.source).toBe('none');
    expect(bare.limits.maxOutputTokens.value).toBeUndefined();
    expect(bare.limits.maxOutputTokens.note).toContain('6000');
    expect(bare.requestMaxTokens).toBe(6_000);
    // 目录写了 8192、窗口只有 480：目录值不可信，按 360 发
    const veo = resolveRuntimeModel(oa(RELAY, 'veo-x'), fixture);
    expect(veo.limits.maxOutputTokens).toMatchObject({ source: 'none', declared: 8_192 });
    expect(veo.requestMaxTokens).toBe(360);
    // 没有资料、窗口够大：仍是 8192，不加说明（与 F01 相同）
    const plain = resolveRuntimeModel(oa(RELAY, 'bare-model'), fixture);
    expect(plain.limits.maxOutputTokens).toEqual({ source: 'none' });
    expect(plain.requestMaxTokens).toBe(8_192);
  });

  it('F02 note 说的是「输出上限」，不再写「max_tokens 按 N 发送」：实际发出的值由请求预算在上限之下再定', () => {
    const notes = {
      // 佐证值替代端点记录的占位值
      replaced: resolveRuntimeModel(oa('https://api.moonshot.cn/v1', 'kimi-k2.6'), excerpt).limits.maxOutputTokens.note!,
      // 没有可采用的值，走兜底
      fallback: resolveRuntimeModel(oa(RELAY, 'moonshotai/kimi-k2.6'), excerpt).limits.maxOutputTokens.note!,
      // 没有资料、窗口又很小
      small: resolveRuntimeModel(oa(RELAY, 'bare-model', { contextWindow: 8_000 }), fixture).limits.maxOutputTokens.note!,
      // F02：被手动窗口挤掉的端点记录，封顶后采用
      capped: resolveRuntimeModel(oa('https://api.vendor-a.example/v1', 'shared-model', { contextWindow: 32_000 }), fixture).limits.maxOutputTokens.note!,
    };
    for (const [name, note] of Object.entries(notes)) {
      expect(note, name).not.toContain('max_tokens 按');
      expect(note, name).not.toContain('max_tokens 改按');
      expect(note, name).not.toContain('发送');
    }
    expect(notes.replaced).toContain('输出上限改按');
    expect(notes.fallback).toContain('输出上限按 8192 计');
    expect(notes.small).toContain('输出上限按窗口的 3/4（6000）计');
    expect(notes.capped).toContain('输出上限按窗口的 3/4（24000）计，单次请求再按上下文剩余空间收紧');
  });

  it('F02 中转（没有端点记录）加手动窗口：佐证值被手动窗口挤掉时同样按手动窗口的 3/4 封顶后采用；手动填的最大输出不受这条规则影响', () => {
    // 汇总的最大输出 8000（两家记录里被取到的最小值）按汇总窗口 128000 可信，手动窗口 8000 放不下它
    const rt = resolveRuntimeModel(oa(RELAY, 'shared-model', { contextWindow: 8_000 }), fixture);
    expect(rt.limits.maxOutputTokens).toMatchObject({ value: 6_000, source: 'aggregate', declared: 8_000 });
    expect(rt.requestMaxTokens).toBe(6_000);
    expect(rt.limits.maxOutputTokens.note).toContain('8000 不小于本配置手动填写的上下文窗口（窗口 8000）：输出上限按窗口的 3/4（6000）计');
    expect(rt.limits.maxOutputTokens.note).toContain('需要更大的输出上限时可在本配置同时手动填写最大输出');
    expect(rt.limits.maxOutputTokens.note).not.toContain('占位写法');
    // 手动窗口放得下目录值时原样采用，不封顶
    const roomy = resolveRuntimeModel(oa(RELAY, 'shared-model', { contextWindow: 64_000 }), fixture);
    expect(roomy.limits.maxOutputTokens).toEqual({ value: 8_000, source: 'aggregate' });
    // 手动填的最大输出照用户填写，比手动窗口的 3/4 大也不改
    const manual = resolveRuntimeModel(oa(RELAY, 'shared-model', { contextWindow: 8_000, maxOutputTokens: 7_500 }), fixture);
    expect(manual.limits.maxOutputTokens).toMatchObject({ value: 7_500, source: 'manual' });
    expect(manual.requestMaxTokens).toBe(7_500);
    // 不变量仍成立：非手动的输出上限不超过窗口的 3/4
    expect(rt.requestMaxTokens).toBeLessThanOrEqual(Math.floor(8_000 * 3 / 4));
  });

  it('目录值是被本配置手动填的窗口挤掉的：原因照实说是手动窗口，不说成「目录的占位写法」；同时手动填最大输出即可放开', () => {
    // 官方 Anthropic 的 claude-sonnet-4-6：记录 128000 / 窗口 1M 是真实规格，被弃用只因为窗口手动改成了 100000
    const sonnet = (extra: Partial<RuntimeModelInput>): RuntimeModelInput => ({ kind: 'anthropic', modelId: 'claude-sonnet-4-6', ...extra });
    const squeezed = resolveRuntimeModel(sonnet({ contextWindow: 100_000 }), excerpt);
    expect(squeezed.limits.contextWindow).toMatchObject({ value: 100_000, source: 'manual' });
    // F02（主会话裁决 2）：不再退到佐证值 64000，按手动窗口的 3/4（75000）封顶后采用端点记录
    expect(squeezed.limits.maxOutputTokens).toMatchObject({ value: 75_000, source: 'endpoint', declared: 128_000 });
    expect(squeezed.requestMaxTokens).toBe(75_000);
    expect(squeezed.limits.maxOutputTokens.note).toContain('本配置手动填写的上下文窗口');
    expect(squeezed.limits.maxOutputTokens.note).toContain('窗口 100000');
    expect(squeezed.limits.maxOutputTokens.note).toContain('同时手动填写最大输出');
    expect(squeezed.limits.maxOutputTokens.note).not.toContain('占位写法');
    // 旧配置里字符串形式的窗口（M4.5 起的字段），连佐证值也放不下：F01R 时落到 8192；
    // F02 起按手动窗口的 3/4（48000）封顶后采用，同样不归咎目录（128000 → 8192 正是 F01R 留给 F02 的残余）
    const tiny = resolveRuntimeModel(sonnet({ contextWindow: '64000' }), excerpt);
    expect(tiny.limits.maxOutputTokens).toMatchObject({ value: 48_000, source: 'endpoint', declared: 128_000 });
    expect(tiny.requestMaxTokens).toBe(48_000);
    expect(tiny.limits.maxOutputTokens.note).toContain('不小于本配置手动填写的上下文窗口');
    expect(tiny.limits.maxOutputTokens.note).toContain('同时手动填写最大输出');
    expect(tiny.limits.maxOutputTokens.note).not.toContain('占位写法');
    // planOf 是不带预算的静态计划：max_tokens 就是输出上限。循环里实际发出的值由请求预算在它之下按剩余空间再收
    expect(buildAnthropicBody(reqOf(planOf(tiny)), tiny.modelId).max_tokens).toBe(48_000);
    // 出路：同时手动填最大输出，原样发送
    const both = resolveRuntimeModel(sonnet({ contextWindow: '64000', maxOutputTokens: 32_000 }), excerpt);
    expect(both.limits.maxOutputTokens).toMatchObject({ value: 32_000, source: 'manual' });
    expect(buildAnthropicBody(reqOf(planOf(both)), both.modelId).max_tokens).toBe(32_000);
    // 对照：窗口来自目录时，仍说明这是目录的占位写法
    const k3 = resolveRuntimeModel(oa('https://api.moonshot.cn/v1', 'kimi-k3'), excerpt);
    expect(k3.limits.maxOutputTokens.note).toContain('多为目录的占位写法');
    expect(k3.limits.maxOutputTokens.note).not.toContain('手动填写的上下文窗口');
  });

  it('手动窗口没有挤掉目录值时不归咎手动窗口：目录值按目录自己的窗口本来就不可信，说明照旧是「目录的占位写法」「确认真实上限后」', async () => {
    const BLAME = '手动填写的上下文窗口';
    // 照目录 / 官方文档把窗口原样填上（等于目录窗口；M4.5 起手改 providers.json 的旧配置多是这样）：
    // 不填时目录值同样被弃用、取值相同，所以「最大输出」这一格与不填时完全一样
    const rows: { input: RuntimeModelInput; request: number; says: string }[] = [
      // 端点记录 == 窗口，退到佐证值
      { input: oa('https://api.moonshot.cn/v1', 'kimi-k2.6'), request: 65_536, says: '多为目录的占位写法' },
      // 0.9 × 窗口的占位值，佐证值同样不可信
      { input: oa('https://openrouter.ai/api/v1', 'moonshotai/kimi-k2.6'), request: 8_192, says: '也没有可采用的佐证值' },
      // 中转：没有端点记录，只有汇总值
      { input: oa(RELAY, 'moonshotai/kimi-k2.6'), request: 8_192, says: '也没有可采用的佐证值' },
    ];
    for (const { input, request, says } of rows) {
      const where = `${input.baseUrl} ${input.modelId}`;
      const auto = resolveRuntimeModel(input, excerpt);
      expect(auto.limits.contextWindow.value, where).toBe(262_144);
      expect(auto.requestMaxTokens, where).toBe(request);
      for (const contextWindow of [262_144, '262144']) {
        const filled = resolveRuntimeModel({ ...input, contextWindow }, excerpt);
        expect(filled.limits.contextWindow, where).toMatchObject({ value: 262_144, source: 'manual', declared: 262_144 });
        expect(filled.limits.maxOutputTokens, where).toEqual(auto.limits.maxOutputTokens);
        const note = filled.limits.maxOutputTokens.note!;
        expect(note, where).toContain(says);
        expect(note, where).toContain('确认真实上限后可在本配置手动填写最大输出');
        expect(note, where).not.toContain(BLAME);
        expect(note, where).not.toContain('同时手动填写最大输出');
        expect(filled.requestMaxTokens, where).toBe(request);
        expect(buildOpenAIBody(reqOf(planOf(filled)), filled.modelId).max_tokens, where).toBe(request);
      }
    }

    // 手动窗口比目录窗口大 / 小，端点记录的 262144 按目录自己的窗口（262144）就不可信：仍是目录的占位写法，不说成手动窗口的原因
    const moonshot = (contextWindow: number): RuntimeModel => resolveRuntimeModel(oa('https://api.moonshot.cn/v1', 'kimi-k2.6', { contextWindow }), excerpt);
    const larger = moonshot(300_000);
    expect(larger.limits.maxOutputTokens).toMatchObject({ value: 65_536, source: 'aggregate', declared: 262_144 });
    expect(larger.limits.maxOutputTokens.note).toContain('262144 超过上下文窗口的 3/4（窗口 300000）');
    expect(larger.limits.maxOutputTokens.note).toContain('多为目录的占位写法');
    expect(larger.limits.maxOutputTokens.note).toContain('确认真实上限后');
    expect(larger.limits.maxOutputTokens.note).not.toContain(BLAME);
    const smaller = moonshot(100_000);
    expect(smaller.limits.maxOutputTokens).toMatchObject({ value: 65_536, source: 'aggregate', declared: 262_144 });
    expect(smaller.limits.maxOutputTokens.note).toContain('262144 不小于上下文窗口（窗口 100000）');
    expect(smaller.limits.maxOutputTokens.note).toContain('多为目录的占位写法');
    expect(smaller.limits.maxOutputTokens.note).toContain('确认真实上限后');
    expect(smaller.limits.maxOutputTokens.note).not.toContain(BLAME);
    // 窗口小到连佐证值 65536 也放不下：说明里点名的（也是规格卡上显示的）目录值 262144 仍是占位值，
    // 出路仍写「确认真实上限后」，不引人照着它去填最大输出（手动值不做检查，填成等于窗口就是每条消息都 400）
    // F02（主会话裁决 2）：佐证值 65536 按目录自己的窗口可信、只是被手动窗口挤掉，按手动窗口的 3/4（48000）封顶后采用
    // （F01R 时落到 8192）。端点记录的 262144 仍照实说成目录的占位写法、不归咎手动窗口；归到手动窗口头上的只有佐证值
    const tiny = moonshot(64_000);
    expect(tiny.limits.maxOutputTokens).toMatchObject({ value: 48_000, source: 'aggregate', declared: 262_144 });
    expect(tiny.requestMaxTokens).toBe(48_000);
    expect(tiny.limits.maxOutputTokens.note).toContain('262144 不小于上下文窗口（窗口 64000），没有给输入留出余量，多为目录的占位写法，未采用');
    expect(tiny.limits.maxOutputTokens.note).toContain('65536 不小于本配置手动填写的上下文窗口（窗口 64000）：输出上限按窗口的 3/4（48000）计');
    expect(tiny.limits.maxOutputTokens.note).toContain('确认真实上限后');

    // 「目录自己的窗口」含官方 Anthropic 的 200K 计法：记录写 1M 窗口 / 180000 输出，不填窗口时按 200K 计、180000 放不下。
    // 把窗口手动填成 200000 什么也没改变，不能因为 180000 小于记录里的 1M 就说成是被手动窗口挤掉的
    const big = await catalogOf({ anthropic: { id: 'anthropic', models: { 'claude-big': {
      limit: { context: 1_000_000, output: 180_000 }, tool_call: true, modalities: { input: ['text'], output: ['text'] },
    } } } });
    const claude = (extra: Partial<RuntimeModelInput> = {}): RuntimeModel => resolveRuntimeModel({ kind: 'anthropic', modelId: 'claude-big', ...extra }, big);
    const clamped = claude();
    expect(clamped.limits.contextWindow).toMatchObject({ value: 200_000, declared: 1_000_000, source: 'endpoint' });
    expect(clamped.limits.maxOutputTokens).toMatchObject({ source: 'none', declared: 180_000 });
    expect(clamped.limits.maxOutputTokens.note).toContain('180000 超过上下文窗口的 3/4（窗口 200000）');
    const refilled = claude({ contextWindow: 200_000 });
    expect(refilled.limits.contextWindow).toMatchObject({ value: 200_000, source: 'manual', declared: 1_000_000 });
    expect(refilled.limits.maxOutputTokens).toEqual(clamped.limits.maxOutputTokens);
    expect(refilled.requestMaxTokens).toBe(8_192);
    expect(buildAnthropicBody(reqOf(planOf(refilled)), refilled.modelId).max_tokens).toBe(8_192);
  });
});

describe('R3 不变量：非手动来源下 1 ≤ max_tokens ≤ 窗口的 3/4 < 窗口', () => {
  it('两套夹具里每个可识别的（服务商，型号）、每个型号经中转与本机地址，都满足', async () => {
    const violations: string[] = [];
    let checked = 0;
    for (const data of [catalogFixture(), catalogFixtureF01R()]) {
      const catalog = await catalogOf(data);
      const providers = data as Record<string, { api?: string; models: Record<string, unknown> }>;
      const inputs: RuntimeModelInput[] = [];
      const ids = new Set<string>();
      for (const [pid, p] of Object.entries(providers)) {
        for (const id of Object.keys(p.models)) {
          ids.add(id);
          if (pid === 'anthropic') inputs.push({ kind: 'anthropic', modelId: id });
          else if (pid === 'google') inputs.push({ kind: 'gemini', modelId: id });
          else if (pid === 'openai') inputs.push(oa('https://api.openai.com/v1', id));
          else if (p.api) inputs.push(oa(p.api, id));
        }
      }
      for (const id of ids) inputs.push(oa(RELAY, id), oa('http://127.0.0.1:9/v1', id));
      for (const input of inputs) {
        const rt = resolveRuntimeModel(input, catalog);
        const window = rt.limits.contextWindow.value ?? 128_000;
        const ceiling = Math.max(1, Math.floor(window * 3 / 4));
        const sent = sentMaxTokens(rt, planOf(rt));
        checked++;
        if (!(sent === rt.requestMaxTokens && sent >= 1 && sent <= ceiling && ceiling < window)) {
          violations.push(`${input.kind} ${input.baseUrl ?? '(官方)'} ${input.modelId}: max_tokens=${sent} 窗口=${window}`);
        }
      }
    }
    expect(violations).toEqual([]);
    expect(checked).toBeGreaterThan(60);
  });

  it('契约常量：outputCeiling 是窗口的 3/4（至少 1），回退窗口 128K', () => {
    expect(outputCeiling(200_000)).toBe(150_000);
    expect(outputCeiling(131_072)).toBe(98_304);
    expect(outputCeiling(1)).toBe(1);
    expect(FALLBACK_CONTEXT_WINDOW).toBe(128_000);
  });
});

describe('R4 文本模态：端点记录不列 text 而别家列了 → 未确认、照常发送（A2）', () => {
  it('Poe 的 openai/gpt-5.4（记录只列 image 输出，别家列 text）：不再整轮拒发', () => {
    const rt = resolveRuntimeModel(oa('https://api.poe.com/v1', 'openai/gpt-5.4', { capabilityOverrides: { imageInput: true, toolCall: true, reasoning: true } }), excerpt);
    expect(rt.endpoint).toMatchObject({ class: 'catalog', catalogProviderId: 'poe' });
    expect(rt.output.text).toMatchObject({ state: 'unknown', catalog: { value: false, source: 'endpoint' }, endpoint: 'unconfirmed' });
    expect(rt.output.text.reason).toContain('其他服务商');
    const plan = planOf(rt);
    expect(plan.blocked).toBeUndefined();
    expect(plan.notices).toEqual([]);
  });

  it('夹具同形状（vendor-a 的 text-dispute）放行；没有任何记录列 text 的专用模型（a-painter）仍拒发', () => {
    const dispute = resolveRuntimeModel(oa('https://api.vendor-a.example/v1', 'text-dispute'), fixture);
    expect(dispute.output.text).toMatchObject({ state: 'unknown', catalog: { value: false, source: 'endpoint' }, endpoint: 'unconfirmed' });
    expect(planOf(dispute).blocked).toBeUndefined();
    expect(planOf(dispute).notices).toEqual([]);
    const painter = resolveRuntimeModel(oa('https://api.vendor-a.example/v1', 'a-painter'), fixture);
    expect(painter.output.text).toMatchObject({ state: 'unsupported', catalog: { value: false, source: 'endpoint' }, endpoint: 'confirmed' });
    expect(planOf(painter).blocked).toContain('不输出文本');
  });

  it('输入一侧是同一条规则：端点记录不列文本输入、别家列了 → 未确认、照常发送；没有任何记录列的仍拒发（收录端点与中转都是）', () => {
    const dispute = resolveRuntimeModel(oa('https://api.vendor-a.example/v1', 'in-dispute'), fixture);
    expect(dispute.input.text).toMatchObject({ state: 'unknown', catalog: { value: false, source: 'endpoint' }, endpoint: 'unconfirmed' });
    expect(dispute.input.text.reason).toContain('其他服务商');
    const plan = planOf(dispute);
    expect(plan.blocked).toBeUndefined();
    expect(plan.notices).toEqual([]);
    expect(buildOpenAIBody(reqOf(plan), dispute.modelId).messages).toContainEqual({ role: 'user', content: 'hi' });
    // 只有一家的记录、输入只列音频：端点自己的记录是确认的否定
    const solo = resolveRuntimeModel(oa('https://api.vendor-a.example/v1', 'in-solo'), fixture);
    expect(solo.input.text).toMatchObject({ state: 'unsupported', catalog: { value: false, source: 'endpoint' }, endpoint: 'confirmed' });
    expect(planOf(solo).blocked).toContain('不接受文本输入');
    // 同一型号经中转：文本的汇总否定只要有一家记录就生效（没有任何记录列出），不套工具 / 图片的 3 家门槛
    const relayed = resolveRuntimeModel(oa(RELAY, 'in-solo'), fixture);
    expect(relayed.input.text).toMatchObject({ state: 'unsupported', catalog: { value: false, source: 'aggregate' } });
    expect(relayed.input.text.reason).toContain('没有任何服务商的记录列出文本输入');
    expect(planOf(relayed).blocked).toContain('不接受文本输入');
  });
});

describe('R5 汇总层的否定：至少 3 家有记录且一致否定才算不支持（C1/D2）', () => {
  it('只有一家否定（solo-neg 经中转）：工具与图片是未确认，照常发送并提示', () => {
    const rt = resolveRuntimeModel(oa(RELAY, 'solo-neg'), fixture);
    expect(rt.toolCall).toMatchObject({ state: 'unknown', catalog: { value: false, source: 'aggregate' }, endpoint: 'unconfirmed' });
    expect(rt.toolCall.reason).toContain('不足 3 家');
    expect(rt.input.image).toMatchObject({ state: 'unknown', catalog: { value: false, source: 'aggregate' } });
    const plan = planOf(rt, 'off', ONE_IMAGE);
    expect(plan.blocked).toBeUndefined();
    expect(plan.sendTools).toBe(true);
    expect(plan.notices.some(n => n.includes('工具调用未确认'))).toBe(true);
    expect(plan.notices.some(n => n.includes('图片输入未确认'))).toBe(true);
    expect('tools' in buildOpenAIBody(reqOf(plan), rt.modelId)).toBe(true);
    // 不带图片的一轮不提图片
    expect(planOf(rt).notices.some(n => n.includes('图片输入未确认'))).toBe(false);
  });

  it('三家一致否定（mute-model 经中转）：不支持，摘工具、带图拒发，原因写明家数', () => {
    const rt = resolveRuntimeModel(oa(RELAY, 'mute-model'), fixture);
    expect(rt.toolCall).toMatchObject({ state: 'unsupported', catalog: { value: false, source: 'aggregate' } });
    expect(rt.toolCall.reason).toContain('3 家');
    expect(rt.input.image.state).toBe('unsupported');
    expect(rt.input.image.reason).toContain('3 家');
    expect(planOf(rt).sendTools).toBe(false);
    expect(planOf(rt, 'off', ONE_IMAGE).blocked).toContain('不支持图片输入');
  });

  it('真实快照：收录端点自己没有该型号时，不让别家 1–2 条记录的否定决定工具与图片', () => {
    const reasoner = resolveRuntimeModel(oa('https://api.deepseek.com', 'deepseek-reasoner'), excerpt);
    expect(reasoner.endpoint.catalogProviderId).toBe('deepseek');
    expect(reasoner.catalog.record).toBe('aggregate');
    expect(planOf(reasoner).sendTools).toBe(true);
    expect(planOf(reasoner, 'off', ONE_IMAGE).blocked).toBeUndefined();
    const doubao = resolveRuntimeModel(oa('https://ark.cn-beijing.volces.com/api/v3', 'doubao-seed-1-6-250615'), excerpt);
    expect(doubao.endpoint.catalogProviderId).toBe('volcengine');
    expect(doubao.catalog.record).toBe('aggregate');
    expect(planOf(doubao).sendTools).toBe(true);
    expect(planOf(doubao, 'off', ONE_IMAGE).blocked).toBeUndefined();
    // 只有 helicone 一家不列图片
    expect(planOf(resolveRuntimeModel(oa(RELAY, 'grok-3'), excerpt), 'off', ONE_IMAGE).blocked).toBeUndefined();
  });

  it('真实快照：三家以上一致否定的仍判不支持；端点自己记录的否定仍是确认', () => {
    const sonar = resolveRuntimeModel(oa(RELAY, 'sonar'), excerpt);
    expect(sonar.toolCall.state).toBe('unsupported');
    expect(planOf(sonar).sendTools).toBe(false);
    // glm-4.6：三家都不列图片 → 带图拒发；工具各家都说支持 → 没有工具类提示
    const glm = resolveRuntimeModel(oa(RELAY, 'glm-4.6'), excerpt);
    expect(planOf(glm, 'off', ONE_IMAGE).blocked).toContain('不支持图片输入');
    expect(planOf(glm).notices).toEqual([]);
    const turbo = resolveRuntimeModel(oa('https://api.openai.com/v1', 'gpt-3.5-turbo'), excerpt);
    expect(turbo.toolCall).toMatchObject({ state: 'unsupported', catalog: { value: false, source: 'endpoint' }, endpoint: 'confirmed' });
    expect('tools' in buildOpenAIBody(reqOf(planOf(turbo)), turbo.modelId)).toBe(false);
  });
});

describe('R6 没有逐家记录的资料（内置族表、离线缓存）', () => {
  it('内置族表的否定没有逐家佐证：只算未确认', async () => {
    const offline = new ModelCatalog(join(dir, 'none.json'), async () => { throw new Error('offline'); });
    expect(await offline.refresh()).toBe(false);
    const rt = resolveRuntimeModel(oa(RELAY, 'gpt-4o'), offline);
    expect(rt.catalog.record).toBe('builtin');
    expect(rt.reasoning).toMatchObject({ state: 'unknown', catalog: { value: false, source: 'builtin' } });
    expect(rt.reasoning.reason).toContain('没有逐家记录');
  });

  it('离线重启：家数从缓存里的服务商记录现算，结论与在线时相同', async () => {
    const file = join(dir, 'offline-cache.json');
    const seed = new ModelCatalog(file, async () => jsonResponse(snapshotExcerpt()));
    expect(await seed.refresh(true)).toBe(true);
    const offline = new ModelCatalog(file, async () => { throw new Error('offline'); });
    const reasoner = resolveRuntimeModel(oa('https://api.deepseek.com', 'deepseek-reasoner'), offline);
    expect(reasoner.toolCall).toMatchObject({ state: 'unknown', catalog: { value: false, source: 'aggregate' } });
    expect(resolveRuntimeModel(oa(RELAY, 'sonar'), offline).toolCall.state).toBe('unsupported');
    expect(resolveRuntimeModel(oa('https://api.moonshot.cn/v1', 'kimi-k3'), offline).requestMaxTokens).toBe(65_536);
  });
});

describe('R7 推理参数：未确认不发（A3）；官方 Gemini 回到预算表、官方 Anthropic 不回退（D4）', () => {
  it('中转上「目录任一家声明支持」不再驱动请求：不发 reasoning_effort 并提示；手动标为支持后才发', () => {
    const rt = resolveRuntimeModel(oa(RELAY, 'kimi-k2.6'), excerpt);
    expect(rt.reasoning).toMatchObject({ state: 'unknown', catalog: { value: true, source: 'aggregate' } });
    const plan = planOf(rt, 'medium');
    expect(plan.thinking.level).toBe('off');
    expect('reasoning_effort' in buildOpenAIBody(reqOf(plan), rt.modelId)).toBe(false);
    expect(plan.notices.some(n => n.includes('未确认') && n.includes('手动修正'))).toBe(true);
    const manual = resolveRuntimeModel(oa(RELAY, 'kimi-k2.6', { capabilityOverrides: { reasoning: true } }), excerpt);
    expect(buildOpenAIBody(reqOf(planOf(manual, 'medium')), manual.modelId).reasoning_effort).toBe('medium');
    // 收录端点但自己没有该型号的记录：同样不发
    expect(planOf(resolveRuntimeModel(oa('https://api.deepseek.com', 'deepseek-reasoner'), excerpt), 'medium').thinking.level).toBe('off');
  });

  it('思考由服务端自适应的三个 Claude 型号：构建器不看档位，中转上也不多出一句无关的提示', () => {
    const rt = resolveRuntimeModel({ kind: 'anthropic', baseUrl: 'https://proxy.example', modelId: 'claude-opus-5-5' }, excerpt);
    expect(rt.reasoning.state).toBe('unknown');
    expect(planOf(rt, 'medium').thinking).toEqual({ level: 'medium' });
    expect(planOf(rt, 'medium').notices).toEqual([]);
  });

  it('官方 Gemini 上目录没有声明预算的型号（只有档位 / 只有开关 / 空数组）：请求体回到 F01 之前的档位预算表', () => {
    for (const modelId of ['gemini-flash-latest', 'gemma-4-31b-it', 'gemini-2.5-flash-image']) {
      const rt = resolveRuntimeModel({ kind: 'gemini', modelId }, excerpt);
      expect(rt.endpoint, modelId).toMatchObject({ class: 'official', catalogProviderId: 'google' });
      expect(rt.reasoning.state, modelId).toBe('supported');
      const plan = planOf(rt, 'medium');
      const req = reqOf(plan);
      const before: StreamRequest = { messages: req.messages, systemPrompt: req.systemPrompt, maxTokens: req.maxTokens, tools: req.tools, thinkingLevel: 'medium' };
      expect(buildGeminiBody(req, modelId), modelId).toEqual(buildGeminiBody(before, modelId));
      expect((buildGeminiBody(req, modelId).generationConfig as { thinkingConfig?: { thinkingBudget: number } }).thinkingConfig?.thinkingBudget, modelId)
        .toBe(Math.min(16_384, plan.maxTokens - 1));
      expect(plan.notices.filter(n => n.includes('推理')), modelId).toEqual([]);
    }
    // 目录声明了预算区间的：预算仍在区间内
    const pro = resolveRuntimeModel({ kind: 'gemini', modelId: 'gemini-2.5-pro' }, excerpt);
    expect(pro.reasoning.control?.budget).toEqual({ min: 128, max: 32_768 });
    expect(planOf(pro, 'high').thinking).toEqual({ level: 'high', budgetTokens: 24_576 });
  });

  it('对照：官方 Gemini 之外的空数组记录仍不另发推理参数；官方 Anthropic 只声明档位的型号不发 budget_tokens', () => {
    const ambient = resolveRuntimeModel(oa('https://api.ambient.xyz/v1', 'moonshotai/kimi-k2.6'), excerpt);
    expect(ambient.endpoint.catalogProviderId).toBe('ambient');
    const plan = planOf(ambient, 'medium');
    expect(plan.thinking.level).toBe('off');
    expect(plan.thinking.note).toContain('没有列出可调的推理参数');
    expect('reasoning_effort' in buildOpenAIBody(reqOf(plan), ambient.modelId)).toBe(false);
    const opus = resolveRuntimeModel({ kind: 'anthropic', modelId: 'claude-opus-4-8' }, excerpt);
    const opusPlan = planOf(opus, 'medium');
    expect('thinking' in buildAnthropicBody(reqOf(opusPlan), opus.modelId)).toBe(false);
    expect(opusPlan.notices.some(n => n.includes('推理'))).toBe(true);
  });

  it('回到预算表只限「官方 Google 主机 + Gemini 协议」：换一种协议接官方主机、或用 Gemini 协议接别的收录端点，仍按端点声明的参数形态走', () => {
    // OpenAI 兼容协议接官方 Google 主机：发的是 reasoning_effort，预算表用不上——声明档位的照档位发，只有开关 / 空数组的不发
    const GOOGLE_OPENAI = 'https://generativelanguage.googleapis.com/v1beta/openai';
    const flash = resolveRuntimeModel(oa(GOOGLE_OPENAI, 'gemini-flash-latest'), excerpt);
    expect(flash.endpoint).toMatchObject({ class: 'official', catalogProviderId: 'google' });
    expect(flash.reasoning).toMatchObject({ state: 'supported', param: 'effort', control: { efforts: ['low', 'medium', 'high'] } });
    const flashPlan = planOf(flash, 'medium');
    expect(flashPlan.thinking).toEqual({ level: 'medium', effort: 'medium' });
    expect(buildOpenAIBody(reqOf(flashPlan), flash.modelId).reasoning_effort).toBe('medium');
    for (const [modelId, why] of [['gemma-4-31b-it', '当前接入只发送 reasoning_effort 档位'], ['gemini-2.5-flash-image', '没有列出可调的推理参数']] as const) {
      const rt = resolveRuntimeModel(oa(GOOGLE_OPENAI, modelId), excerpt);
      expect(rt.endpoint, modelId).toMatchObject({ class: 'official', catalogProviderId: 'google' });
      expect(rt.reasoning, modelId).toMatchObject({ state: 'supported', param: 'effort' });
      const plan = planOf(rt, 'medium');
      expect(plan.thinking.level, modelId).toBe('off');
      expect(plan.thinking.note, modelId).toContain(why);
      expect('reasoning_effort' in buildOpenAIBody(reqOf(plan), modelId), modelId).toBe(false);
    }
    // Gemini 协议接官方 Google 之外的收录端点：记录没有声明预算（空数组 / 只有档位）的不另发 thinkingBudget，与 F01 相同
    for (const [baseUrl, modelId, provider, why] of [
      ['https://api.ambient.xyz/v1', 'moonshotai/kimi-k2.6', 'ambient', '没有列出可调的推理参数'],
      ['https://api.moonshot.cn/v1', 'kimi-k3', 'moonshotai-cn', '当前接入只实现推理预算参数'],
    ] as const) {
      const rt = resolveRuntimeModel({ kind: 'gemini', baseUrl, modelId }, excerpt);
      expect(rt.endpoint, modelId).toMatchObject({ class: 'catalog', catalogProviderId: provider });
      expect(rt.reasoning, modelId).toMatchObject({ state: 'supported', param: 'budget' });
      expect(rt.reasoning.control?.budget, modelId).toBeUndefined();
      const plan = planOf(rt, 'medium');
      expect(plan.thinking.level, modelId).toBe('off');
      expect(plan.thinking.note, modelId).toContain(why);
      expect('thinkingConfig' in (buildGeminiBody(reqOf(plan), modelId).generationConfig as Record<string, unknown>), modelId).toBe(false);
    }
  });

  it('官方端点同样受「未确认不发」约束（目录落到内置族表时，含官方 Gemini）：提示照实说是没有这个型号的目录记录，不把官方端点说成中转', async () => {
    const offline = new ModelCatalog(join(dir, 'none-official.json'), async () => { throw new Error('offline'); });
    expect(await offline.refresh()).toBe(false);
    const cases: { input: RuntimeModelInput; sent: (plan: SlotPlan) => Record<string, unknown>; key: string }[] = [
      { input: { kind: 'gemini', modelId: 'gemini-2.5-pro' }, sent: p => buildGeminiBody(reqOf(p), 'gemini-2.5-pro').generationConfig as Record<string, unknown>, key: 'thinkingConfig' },
      { input: { kind: 'anthropic', modelId: 'claude-sonnet-4-5' }, sent: p => buildAnthropicBody(reqOf(p), 'claude-sonnet-4-5'), key: 'thinking' },
      { input: oa('https://api.openai.com/v1', 'gpt-5'), sent: p => buildOpenAIBody(reqOf(p), 'gpt-5'), key: 'reasoning_effort' },
    ];
    for (const { input, sent, key } of cases) {
      const rt = resolveRuntimeModel(input, offline);
      const where = `${input.kind} ${input.modelId}`;
      expect(rt.endpoint.class, where).toBe('official');
      expect(rt.catalog.record, where).toBe('builtin');
      expect(rt.reasoning, where).toMatchObject({ state: 'unknown', catalog: { value: true, source: 'builtin' } });
      expect(rt.reasoning.reason, where).toContain('当前端点没有这个型号的目录记录');
      expect(rt.reasoning.reason, where).not.toContain('中转');
      const plan = planOf(rt, 'medium');
      expect(plan.thinking.level, where).toBe('off');
      expect(key in sent(plan), where).toBe(false);
      expect(plan.notices.some(n => n.includes('未确认') && n.includes('没有这个型号的目录记录') && n.includes('手动修正')), where).toBe(true);
    }
  });

  it('官方记录里没有这个型号（只有别家记录说支持推理）：官方 Gemini 也不发 thinkingConfig，手动标为支持后才发；各类端点的「未确认」各说各的原因', () => {
    const third = resolveRuntimeModel({ kind: 'gemini', modelId: 'gem-third' }, fixture);
    expect(third.endpoint).toMatchObject({ class: 'official', catalogProviderId: 'google' });
    expect(third.catalog.record).toBe('aggregate');
    expect(third.reasoning).toMatchObject({ state: 'unknown', catalog: { value: true, source: 'aggregate' } });
    expect(third.reasoning.reason).toBe('跨服务商汇总标注支持推理，但当前端点没有这个型号的目录记录，未确认');
    const plan = planOf(third, 'medium');
    expect(plan.thinking.level).toBe('off');
    expect('thinkingConfig' in (buildGeminiBody(reqOf(plan), third.modelId).generationConfig as Record<string, unknown>)).toBe(false);
    const manual = resolveRuntimeModel({ kind: 'gemini', modelId: 'gem-third', capabilityOverrides: { reasoning: true } }, fixture);
    expect((buildGeminiBody(reqOf(planOf(manual, 'medium')), manual.modelId).generationConfig as { thinkingConfig?: unknown }).thinkingConfig)
      .toEqual({ thinkingBudget: 16_384, includeThoughts: true });
    // 收录的服务商：自己没有这个型号的记录 / 有记录但没写推理这一项
    const absent = resolveRuntimeModel(oa('https://api.vendor-b.example/openai/v1', 'gem-third'), fixture);
    expect(absent.endpoint).toMatchObject({ class: 'catalog', catalogProviderId: 'vendor-b' });
    expect(absent.catalog.record).toBe('aggregate');
    expect(absent.reasoning.reason).toBe('跨服务商汇总标注支持推理，但当前端点没有这个型号的目录记录，未确认');
    const silent = resolveRuntimeModel(oa('https://api.vendor-a.example/v1', 'in-dispute'), fixture);
    expect(silent.catalog.record).toBe('endpoint');
    expect(silent.reasoning.reason).toBe('跨服务商汇总标注支持推理，但当前端点的目录记录没有写这一项，未确认');
    // 中转与本机保留原来的说法
    for (const baseUrl of [RELAY, 'http://127.0.0.1:9/v1']) {
      expect(resolveRuntimeModel(oa(baseUrl, 'gem-third'), fixture).reasoning.reason, baseUrl).toBe('跨服务商汇总标注支持推理，但当前端点（中转、本机或未收录）未确认');
    }
  });
});

describe('R8 回环地址不参与目录 api 匹配（C2）', () => {
  it('目录里登记了回环 api 的服务商不认领本机端口：本机端点、能力未确认', () => {
    const urls = fixture.providerApiUrls();
    expect(urls['loop-lab']).toBe('http://localhost:8080/v1');
    expect(describeEndpoint('openai-compat', 'http://localhost:8080/v1', urls)).toEqual({ class: 'local', host: 'localhost' });
    expect(describeEndpoint('ollama', 'http://localhost:8080/v1', urls)).toEqual({ class: 'local', host: 'localhost' });
    const rt = resolveRuntimeModel(oa('http://localhost:8080/v1', 'loop-only'), fixture);
    expect(rt.catalog.record).toBe('aggregate');
    expect(rt.toolCall).toMatchObject({ state: 'unknown', endpoint: 'unconfirmed' });
    expect(planOf(rt).sendTools).toBe(true);
  });

  it('真实快照：privatemode-ai（localhost:8080）与 lmstudio（127.0.0.1:1234）登记的回环 api', () => {
    const kimi = resolveRuntimeModel(oa('http://localhost:8080/v1', 'kimi-k2.6'), excerpt);
    expect(kimi.endpoint).toEqual({ class: 'local', host: 'localhost' });
    expect([kimi.toolCall.state, kimi.input.image.state]).toEqual(['unknown', 'unknown']);
    expect(kimi.requestMaxTokens).toBe(65_536);
    expect(resolveRuntimeModel(oa('http://127.0.0.1:1234/v1', 'qwen/qwen3-coder-30b'), excerpt).endpoint).toEqual({ class: 'local', host: '127.0.0.1' });
  });
});

describe('R9 官方 Anthropic 主机的 200K 计法不看窗口来自哪一层、用哪种协议（C3）', () => {
  const expectClamped = (rt: RuntimeModel, source: string): void => {
    expect(rt.endpoint).toMatchObject({ class: 'official', catalogProviderId: 'anthropic' });
    expect(rt.limits.contextWindow).toMatchObject({ value: 200_000, declared: 1_000_000, source });
    expect(rt.limits.contextWindow.note).toContain('beta');
  };
  it('仅第三方收录、官方记录缺窗口：窗口来自汇总层，同样按 200K', () => {
    expectClamped(resolveRuntimeModel({ kind: 'anthropic', modelId: 'claude-third' }, fixture), 'aggregate');
    const nolimit = resolveRuntimeModel({ kind: 'anthropic', modelId: 'claude-nolimit' }, fixture);
    expect(nolimit.catalog.record).toBe('endpoint');
    expectClamped(nolimit, 'aggregate');
  });
  it('备用目录（basellm）给的 1M', async () => {
    const backup = new ModelCatalog(join(dir, 'basellm.json'), async (url: unknown) => String(url).includes('models.dev')
      ? new Response('unavailable', { status: 503 })
      : jsonResponse({ success: true, data: [{ model_name: 'claude-b', vendor_name: 'Anthropic', tags: 'Reasoning,1M' }] }));
    expect(await backup.refresh(true)).toBe(true);
    expectClamped(resolveRuntimeModel({ kind: 'anthropic', modelId: 'claude-b' }, backup), 'basellm');
  });
  it('用 OpenAI 兼容协议接官方 Anthropic 主机', () => {
    expectClamped(resolveRuntimeModel(oa('https://api.anthropic.com/v1', 'claude-x'), fixture), 'endpoint');
  });
});

describe('R10 官方主机表不把原型键当成官方端点（C4）', () => {
  it('主机名是 constructor / __proto__ 时按中转处理', () => {
    for (const host of ['constructor', '__proto__']) {
      const got = describeEndpoint('openai-compat', `https://${host}/v1`, {});
      expect(got).toEqual({ class: 'relay', host });
      expect(JSON.stringify(got)).not.toContain('catalogProviderId');
    }
  });
});

describe('R11 工具记录转文字后各段以换行分隔（D5）', () => {
  const use = (id: string, text: string) => ({ type: 'toolUse' as const, value: { toolUseId: id, name: 'echo', input: JSON.stringify({ text }) } });
  const result = (id: string, output: string, success: boolean) => ({ type: 'toolResult' as const, value: { toolUseId: id, output, success, status: success ? 'success' as const : 'failed' as const } });
  const plain = (messages: AgentMessage[]): StreamRequest => ({ messages, systemPrompt: '', maxTokens: 100, tools: [], thinkingLevel: 'off' });

  it('OpenAI 兼容构建器把一条消息的文本段直接拼接：转换后的各段不粘连', () => {
    const flat = flattenToolHistory([
      { role: 'assistant', parts: [{ type: 'text', value: '我来查' }, use('A', 'a'), use('B', 'b')] },
      { role: 'user', parts: [result('A', 'alpha', true), result('B', 'beta', false)] },
    ]);
    const sent = buildOpenAIBody(plain(flat), 'm').messages as { role: string; content: unknown }[];
    expect(sent[0]).toEqual({ role: 'assistant', content: '我来查\n[历史工具调用] echo 参数: {"text":"a"}\n[历史工具调用] echo 参数: {"text":"b"}' });
    expect(sent[1]).toEqual({ role: 'user', content: '[历史工具结果] 成功: <tool-output>\nalpha\n</tool-output>\n[历史工具结果] 失败: <tool-output>\nbeta\n</tool-output>' });
    // Anthropic 的独立文本块：块数不变，都非空
    const blocks = (buildAnthropicBody(plain(flat), 'claude-x').messages as { content: { type: string; text: string }[] }[]).map(m => m.content);
    expect(blocks.map(b => b.length)).toEqual([3, 2]);
    expect(blocks.flat().every(b => b.type === 'text' && b.text.trim() !== '')).toBe(true);
  });

  it('文本段之间隔着别的内容（图片）也不粘连；不含工具块的消息原样返回', () => {
    const image = { type: 'imageData' as const, value: { mimeType: 'image/png', base64: 'eA==' } };
    const untouched: AgentMessage = { role: 'user', parts: [{ type: 'text', value: '甲' }, { type: 'text', value: '乙' }] };
    const flat = flattenToolHistory([
      { role: 'assistant', parts: [use('A', 'a')] },
      { role: 'user', parts: [result('A', 'alpha', true), image, { type: 'text', value: '原话' }] },
      untouched,
    ]);
    expect(flat[2]).toBe(untouched);
    expect(flat.map(m => m.parts.length)).toEqual([1, 3, 2]);
    const sent = buildOpenAIBody(plain(flat), 'm').messages as { role: string; content: any }[];
    expect(sent[0].content).toBe('[历史工具调用] echo 参数: {"text":"a"}');
    expect(sent[1].content[0]).toEqual({ type: 'text', text: '[历史工具结果] 成功: <tool-output>\nalpha\n</tool-output>\n原话' });
    expect(sent[1].content[1].type).toBe('image_url');
  });
});
