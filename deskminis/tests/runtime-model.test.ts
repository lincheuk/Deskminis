/**
 * F01 resolveRuntimeModel / planSlot 的纯逻辑：同名模型按「配置实例 + 端点 + 模型」分别解析、三层取交集、
 * 手动修正只作用于本实例、旧配置与旧缓存有明确结果、每个槽位的推理 / 输出 / 工具 / 图片计划合法。
 * 目录用真 ModelCatalog + 夹具（不发网络请求）；端到端的请求体断言在 runtime-model-loop / runtime-model-e2e 两个文件里。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelCatalog } from '../src/minisd/providers/model-catalog';
import {
  countImageNeeds, decideThinking, describeEndpoint, mapEffort, normalizeInstanceOverrides, parseOverrideInput, planSlot, resolveRuntimeModel,
  type RuntimeModelInput,
} from '../src/minisd/providers/runtime-model';
import { buildOpenAIBody } from '../src/minisd/providers/openai';
import { buildAnthropicBody } from '../src/minisd/providers/anthropic';
import { buildGeminiBody } from '../src/minisd/providers/gemini';
import type { AgentMessage } from '../src/shared/types';
import type { StreamRequest } from '../src/minisd/providers/types';
import { EXAMPLE_APIS, catalogFixture, jsonResponse } from './runtime-model-fixture';

let dir: string;
let cacheFile: string;
let catalog: ModelCatalog;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dm-runtime-'));
  cacheFile = join(dir, 'catalog.json');
  catalog = new ModelCatalog(cacheFile, async () => jsonResponse(catalogFixture()));
  expect(await catalog.refresh(true)).toBe(true);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const A: RuntimeModelInput = { id: 'A', name: '甲', kind: 'openai-compat', baseUrl: EXAMPLE_APIS.vendorA, modelId: 'shared-model' };
const B: RuntimeModelInput = { id: 'B', name: '乙', kind: 'openai-compat', baseUrl: EXAMPLE_APIS.vendorB, modelId: 'shared-model' };
const RELAY: RuntimeModelInput = { kind: 'openai-compat', baseUrl: 'https://relay.example/v1', modelId: 'shared-model' };
const NO_NEEDS = { currentImages: 0, historyImages: 0 };

describe('端点识别：内置官方主机 → 目录 api 前缀 → 本机 / 中转', () => {
  const apis = catalogFixture() as Record<string, { api?: string }>;
  const urls = Object.fromEntries(Object.entries(apis).flatMap(([id, p]) => p.api ? [[id, p.api]] : []));
  it('官方端点（含各类型 baseUrl 留空时的缺省地址）', () => {
    expect(describeEndpoint('anthropic', undefined, urls)).toEqual({ class: 'official', host: 'api.anthropic.com', catalogProviderId: 'anthropic' });
    expect(describeEndpoint('gemini', '  ', urls)).toMatchObject({ class: 'official', catalogProviderId: 'google' });
    expect(describeEndpoint('openai-compat', 'https://api.openai.com/v1', urls)).toMatchObject({ class: 'official', catalogProviderId: 'openai' });
    // 明文 http 不算官方端点（中间人能改写），按中转处理
    expect(describeEndpoint('anthropic', 'http://api.anthropic.com', urls)).toMatchObject({ class: 'relay' });
  });
  it('目录收录的服务商：api 地址按路径段做前缀，取最长；分不清（同样长的两家）按中转', () => {
    expect(describeEndpoint('openai-compat', 'https://api.vendor-a.example/v1/', urls)).toMatchObject({ class: 'catalog', catalogProviderId: 'vendor-a' });
    expect(describeEndpoint('openai-compat', 'https://API.vendor-a.example/v1/chat', urls)).toMatchObject({ class: 'catalog', catalogProviderId: 'vendor-a' });
    expect(describeEndpoint('openai-compat', 'https://api.vendor-b.example/openai/v1', urls)).toMatchObject({ class: 'catalog', catalogProviderId: 'vendor-b' });
    expect(describeEndpoint('openai-compat', 'https://api.vendor-a.example', urls)).toMatchObject({ class: 'relay' });
    expect(describeEndpoint('openai-compat', 'https://api.vendor-a.example/v10', urls)).toMatchObject({ class: 'relay' });
    expect(describeEndpoint('openai-compat', 'http://api.vendor-a.example/v1', urls)).toMatchObject({ class: 'relay' });
    expect(describeEndpoint('openai-compat', 'https://tie.example/v1', urls)).toMatchObject({ class: 'relay' });
  });
  it('本机与中转、坏地址', () => {
    expect(describeEndpoint('ollama', undefined, urls)).toMatchObject({ class: 'local', host: 'localhost' });
    expect(describeEndpoint('openai-compat', 'http://127.0.0.1:8080/v1', urls)).toMatchObject({ class: 'local' });
    expect(describeEndpoint('openai-compat', 'http://[::1]:8080/v1', urls)).toMatchObject({ class: 'local' });
    expect(describeEndpoint('openai-compat', 'https://relay.example/v1', urls)).toEqual({ class: 'relay', host: 'relay.example' });
    expect(describeEndpoint('openai-compat', 'not a url', urls)).toEqual({ class: 'relay' });
  });
});

describe('验收 1：同一 modelId、不同服务商与手动修正，分别解析且互不污染', () => {
  it('两家服务商各用自己的记录：窗口、输出、工具、图片、推理都不同', () => {
    const a = resolveRuntimeModel(A, catalog);
    const b = resolveRuntimeModel(B, catalog);
    expect(a.endpoint).toMatchObject({ class: 'catalog', catalogProviderId: 'vendor-a' });
    expect(b.endpoint).toMatchObject({ class: 'catalog', catalogProviderId: 'vendor-b' });
    expect(a.limits.contextWindow).toEqual({ value: 200_000, source: 'endpoint' });
    expect(b.limits.contextWindow).toEqual({ value: 128_000, source: 'endpoint' });
    expect([a.requestMaxTokens, b.requestMaxTokens]).toEqual([32_000, 8_000]);
    expect([a.toolCall.state, b.toolCall.state]).toEqual(['supported', 'unsupported']);
    expect([a.input.image.state, b.input.image.state]).toEqual(['supported', 'unsupported']);
    expect(a.reasoning).toMatchObject({ state: 'supported', param: 'effort', control: { efforts: ['low', 'high', 'max'] } });
    expect(b.reasoning.state).toBe('unsupported');
    expect(a).toMatchObject({ instanceId: 'A', instanceName: '甲', catalog: { record: 'endpoint', name: 'Shared Model', stale: false } });
  });

  it('A 的手动修正只改 A；清空后回到 A 自己的记录（不是 B 的，也没有旧值残留）', () => {
    const a2 = resolveRuntimeModel({ ...A, contextWindow: 150_000, maxOutputTokens: 20_000, capabilityOverrides: { toolCall: false } }, catalog);
    expect(a2.limits.contextWindow).toEqual({ value: 150_000, source: 'manual', declared: 200_000 });
    expect(a2.limits.maxOutputTokens).toEqual({ value: 20_000, source: 'manual', declared: 32_000 });
    expect(a2.requestMaxTokens).toBe(20_000);
    // 修正单独记在 manual：目录对模型本身的说法（vendor-a 记录：支持）原样保留，界面才能并排显示两者
    expect(a2.toolCall).toMatchObject({ state: 'unsupported', manual: false, catalog: { value: true, source: 'endpoint' }, endpoint: 'confirmed' });
    expect(a2.toolCall.reason).toContain('手动标为不支持');
    const b = resolveRuntimeModel(B, catalog);
    expect([b.limits.contextWindow.value, b.requestMaxTokens]).toEqual([128_000, 8_000]);
    const cleared = resolveRuntimeModel(A, catalog);
    expect([cleared.limits.contextWindow.value, cleared.requestMaxTokens, cleared.toolCall.state]).toEqual([200_000, 32_000, 'supported']);
  });

  it('旧的按 modelId 全局覆盖表（M4.5 setManualOverride）对运行时解析不起作用', () => {
    catalog.setManualOverride('shared-model', 999_999);
    catalog.setMaxOutputOverride('shared-model', 7);
    const a = resolveRuntimeModel(A, catalog);
    expect([a.limits.contextWindow.value, a.requestMaxTokens]).toEqual([200_000, 32_000]);
  });

  it('中转不因型号名相同就继承服务商的能力：数字按跨服务商汇总，能力至多「未确认」', () => {
    const relay = resolveRuntimeModel(RELAY, catalog);
    expect(relay.endpoint.class).toBe('relay');
    expect(relay.catalog.record).toBe('aggregate');
    // 两家各报一个值，没有佐证 → 纯最小（F01 之前的运行时规则）
    expect(relay.limits.contextWindow).toEqual({ value: 128_000, source: 'aggregate' });
    expect(relay.requestMaxTokens).toBe(8_000);
    // 两家说法不一：没有共识 → 没有资料
    expect(relay.toolCall).toMatchObject({ state: 'unknown', endpoint: 'unconfirmed', catalog: { source: 'none' } });
    expect(relay.input.image.state).toBe('unknown');
    // 推理沿用旧的「任一家声明即为提示」，但只是未确认、不带端点的控制方式
    expect(relay.reasoning).toMatchObject({ state: 'unknown', catalog: { value: true, source: 'aggregate' } });
    expect(relay.reasoning.control).toBeUndefined();
    // 只有官方记录的型号：经中转时也拿不到「支持」
    const claudeViaRelay = resolveRuntimeModel({ kind: 'anthropic', baseUrl: 'https://proxy.example', modelId: 'claude-x' }, catalog);
    expect(claudeViaRelay.input.image).toMatchObject({ state: 'unknown', catalog: { value: true, source: 'aggregate' }, endpoint: 'unconfirmed' });
    expect(claudeViaRelay.toolCall.state).toBe('unknown');
    expect(claudeViaRelay.limits.contextWindow).toEqual({ value: 1_000_000, source: 'aggregate' });
  });

  it('汇总层按模态逐项看：每家都列的算声明支持（仍未确认），没有一家列的是否定——不足 3 家的否定算未确认，有分歧的算没资料', () => {
    const vision = resolveRuntimeModel({ ...RELAY, modelId: 'vision-model' }, catalog);
    expect(vision.input.image).toMatchObject({ state: 'unknown', catalog: { value: true, source: 'aggregate' } });
    expect(vision.input.pdf.catalog).toEqual({ source: 'none' });
    expect(vision.input.video.catalog).toEqual({ value: false, source: 'aggregate' });
    const plain = resolveRuntimeModel({ ...RELAY, modelId: 'plain-model' }, catalog);
    // F01R（C1/D2）：只有两家记录、都不列图片——不足 3 家，不据此判定当前端点：未确认，带图照发并提示（三家一致的正向见 runtime-model-review R5）
    expect(plain.input.image).toMatchObject({ state: 'unknown', catalog: { value: false, source: 'aggregate' }, endpoint: 'unconfirmed' });
    const withImage = planSlot(plain, 'off', { currentImages: 1, historyImages: 0 }, 'P');
    expect(withImage.blocked).toBeUndefined();
    expect(withImage.notices.some(n => n.includes('图片输入未确认'))).toBe(true);
    // 中转可以手动确认收图片
    expect(resolveRuntimeModel({ ...RELAY, modelId: 'plain-model', capabilityOverrides: { imageInput: true } }, catalog).input.image.state).toBe('supported');
    // 展示用的整组共识（provider.models.metadata）不变：两家列表不同 → 不写
    expect(catalog.getModelMetadata('plain-model').inputModalities).toBeUndefined();
  });

  it('官方 Anthropic 端点 200K 以上的窗口按 200K 计（不发长上下文 beta 头）；手动填写可以放开', () => {
    const official = resolveRuntimeModel({ kind: 'anthropic', modelId: 'claude-x' }, catalog);
    expect(official.limits.contextWindow).toMatchObject({ value: 200_000, source: 'endpoint', declared: 1_000_000 });
    expect(official.limits.contextWindow.note).toContain('beta');
    expect(official.input.image.state).toBe('supported');
    const manual = resolveRuntimeModel({ kind: 'anthropic', modelId: 'claude-x', contextWindow: 1_000_000 }, catalog);
    expect(manual.limits.contextWindow).toEqual({ value: 1_000_000, source: 'manual', declared: 1_000_000 });
  });
});

describe('验收 3：目录支持、应用或端点没实现的能力标为不可用并给原因', () => {
  it('理解视频的文本模型：视频输入不可用（模型支持、应用未接入）；输出只有文本，不显示成能生成视频', () => {
    const gem = resolveRuntimeModel({ kind: 'gemini', modelId: 'gem-v' }, catalog);
    expect(gem.input.video).toMatchObject({ state: 'unavailable', transport: 'app-missing', catalog: { value: true, source: 'endpoint' } });
    expect(gem.input.video.reason).toContain('模型支持视频输入');
    expect(gem.input.video.reason).toContain('G03');
    expect(gem.input.audio.state).toBe('unavailable');
    expect(gem.input.pdf).toMatchObject({ state: 'unavailable', catalog: { value: true } });
    expect(gem.input.image.state).toBe('supported');
    expect(gem.output.text.state).toBe('supported');
    expect(gem.output.video).toMatchObject({ state: 'unavailable', catalog: { value: false, source: 'endpoint' } });
    expect(gem.structuredOutput).toMatchObject({ state: 'unavailable', catalog: { value: true } });
  });

  it('手动修正打不开没实现的传输：音视频之类的修正项不被接受，照实列为无效', () => {
    const r = resolveRuntimeModel({ kind: 'gemini', modelId: 'gem-v', capabilityOverrides: { videoInput: true, imageInput: false } }, catalog);
    expect(r.input.video.state).toBe('unavailable');
    expect(r.input.image).toMatchObject({ state: 'unsupported', manual: false, catalog: { value: true, source: 'endpoint' } });
    expect(r.overrides.invalid).toEqual(['capabilityOverrides.videoInput']);
    expect(() => parseOverrideInput({ capabilityOverrides: { videoInput: true } })).toThrow('未知的能力修正项');
  });

  it('只出视频 / 只出图的专用模型：生成能力不可用、文本输出不支持，这个槽位接不了对话', () => {
    const veo = resolveRuntimeModel({ kind: 'openai-compat', baseUrl: 'https://relay.example/v1', modelId: 'veo-x' }, catalog);
    expect(veo.output.video).toMatchObject({ state: 'unavailable', catalog: { value: true, source: 'aggregate' } });
    expect(veo.output.video.reason).toContain('当前应用只接入文本输出');
    expect(veo.output.text.state).toBe('unsupported');
    expect(planSlot(veo, 'off', NO_NEEDS, '视频').blocked).toContain('不输出文本');
    const painter = resolveRuntimeModel({ kind: 'openai-compat', baseUrl: 'https://relay.example/v1', modelId: 'painter' }, catalog);
    expect(painter.limits.maxOutputTokens).toEqual({ value: 0, source: 'aggregate' });
    expect(painter.requestMaxTokens).toBe(8192);
    expect(planSlot(painter, 'off', NO_NEEDS, '画').blocked).toContain('不输出文本');
  });
});

describe('验收 4：缺字段、未知中转、手动修正、离线旧缓存、旧配置迁移都有明确结果', () => {
  it('缺字段：有的用、没有的就是未确认（不当成不支持，也不当成支持）', () => {
    const bare = resolveRuntimeModel({ kind: 'openai-compat', baseUrl: 'https://relay.example/v1', modelId: 'bare-model' }, catalog);
    expect(bare.limits.contextWindow).toEqual({ value: 32_000, source: 'aggregate' });
    expect(bare.limits.maxOutputTokens).toEqual({ source: 'none' });
    expect(bare.requestMaxTokens).toBe(8192);
    expect(bare.toolCall).toMatchObject({ state: 'unknown', catalog: { source: 'none' } });
    expect(bare.input.image.state).toBe('unknown');
    expect(bare.reasoning.state).toBe('unknown');
    const mystery = resolveRuntimeModel({ kind: 'openai-compat', baseUrl: 'https://relay.example/v1', modelId: 'mystery-9' }, catalog);
    expect(mystery.catalog.record).toBe('none');
    expect(mystery.limits.contextWindow).toEqual({ source: 'none' });
  });

  it('离线 + 旧规则缓存（mergeRule 2）：缓存作废、按内置族表，来源与「待更新」照实标出', async () => {
    writeFileSync(cacheFile, JSON.stringify({ mergeRule: 2, source: 'models.dev', fetchedAt: Date.now(), models: { 'shared-model': { contextWindow: 999_999 } } }));
    const offline = new ModelCatalog(cacheFile, async () => { throw new Error('offline'); });
    expect(await offline.refresh()).toBe(false);
    const claude = resolveRuntimeModel({ kind: 'anthropic', modelId: 'claude-future' }, offline);
    expect(claude.catalog).toMatchObject({ record: 'builtin', stale: true });
    expect(claude.limits.contextWindow).toEqual({ value: 200_000, source: 'builtin' });
    expect(claude.input.image.state).toBe('unknown');
    expect(claude.reasoning).toMatchObject({ state: 'unknown', catalog: { value: true, source: 'builtin' } });
    const stale = resolveRuntimeModel(A, offline);
    expect(stale.endpoint.class).toBe('relay');
    expect(stale.limits.contextWindow).toEqual({ source: 'none' });
  });

  it('F01 之前写下的 v3 缓存没有服务商 api 地址：照常可用，只是下一次刷新前只认内置官方端点', () => {
    const raw = JSON.parse(readFileSync(cacheFile, 'utf8'));
    expect(raw.providerApis['vendor-a']).toBe(EXAMPLE_APIS.vendorA);
    delete raw.providerApis;
    writeFileSync(cacheFile, JSON.stringify(raw));
    const old = new ModelCatalog(cacheFile, async () => { throw new Error('offline'); });
    expect(resolveRuntimeModel(A, old).endpoint.class).toBe('relay');
    expect(resolveRuntimeModel({ kind: 'anthropic', modelId: 'claude-x' }, old).catalog.record).toBe('endpoint');
  });

  it('旧配置迁移：手改的数字字符串照收；非法值忽略并列出；null 视为没填', () => {
    expect(normalizeInstanceOverrides({ contextWindow: '200000' })).toEqual({ contextWindow: 200_000, invalid: [] });
    expect(normalizeInstanceOverrides({ contextWindow: '200k', maxOutputTokens: -1 }).invalid).toEqual(['contextWindow="200k"', 'maxOutputTokens=-1']);
    expect(normalizeInstanceOverrides({ contextWindow: 1.5 }).invalid).toEqual(['contextWindow=1.5']);
    expect(normalizeInstanceOverrides({ contextWindow: null, maxOutputTokens: undefined })).toEqual({ invalid: [] });
    expect(normalizeInstanceOverrides({ capabilityOverrides: { imageInput: true, toolCall: 'yes' } }))
      .toEqual({ capabilityOverrides: { imageInput: true }, invalid: ['capabilityOverrides.toolCall="yes"'] });
    const legacy = resolveRuntimeModel({ ...A, contextWindow: '200k' }, catalog);
    expect(legacy.limits.contextWindow).toEqual({ value: 200_000, source: 'endpoint' });
    expect(legacy.overrides.invalid).toEqual(['contextWindow="200k"']);
  });

  it('设置页 / RPC 入参：不合法当场报错；null 清空；只处理出现了的键', () => {
    expect(() => parseOverrideInput({ contextWindow: 0 })).toThrow('上下文窗口');
    expect(() => parseOverrideInput({ maxOutputTokens: '8000' })).toThrow('最大输出');
    expect(() => parseOverrideInput({ capabilityOverrides: { imageInput: 'yes' } })).toThrow('布尔');
    expect(() => parseOverrideInput({ capabilityOverrides: [true] })).toThrow('对象');
    const r = parseOverrideInput({ contextWindow: null, capabilityOverrides: { imageInput: true, toolCall: null } });
    expect([...r.present]).toEqual(['contextWindow', 'capabilityOverrides']);
    expect(r.contextWindow).toBeUndefined();
    expect(r.capabilityOverrides).toEqual({ imageInput: true });
    expect(parseOverrideInput({ name: 'x' }).present.size).toBe(0);
  });

  it('对外交出的目录条目是副本：改它不会回写目录', () => {
    const rec = catalog.getEndpointRecord('vendor-a', 'shared-model')!;
    rec.inputModalities!.push('video');
    rec.reasoningControl!.efforts!.push('xhigh');
    const again = catalog.getEndpointRecord('vendor-a', 'shared-model')!;
    expect(again.inputModalities).toEqual(['image', 'text']);
    expect(again.reasoningControl).toEqual({ efforts: ['low', 'high', 'max'] });
  });
});

describe('验收 2 的参数规则：每个槽位各自决定推理参数', () => {
  it('档位映射：同名直用；否则取不高于它的最高档，没有再取高于它的最低档', () => {
    expect(mapEffort('medium', ['low', 'high', 'max'])).toBe('low');
    expect(mapEffort('high', ['low', 'high', 'max'])).toBe('high');
    expect(mapEffort('low', ['high', 'max'])).toBe('high');
    expect(mapEffort('low', ['minimal', 'high'])).toBe('minimal');
    expect(mapEffort('medium', ['none'])).toBeUndefined();
  });

  it('OpenAI 兼容：支持的映射到端点声明的档位；不支持的关掉并说明', () => {
    const a = resolveRuntimeModel(A, catalog);
    const b = resolveRuntimeModel(B, catalog);
    expect(decideThinking(a, 'medium', a.requestMaxTokens, '甲')).toEqual({ level: 'medium', effort: 'low', note: expect.stringContaining('medium 改为 low') });
    expect(decideThinking(a, 'high', a.requestMaxTokens, '甲')).toEqual({ level: 'high', effort: 'high' });
    expect(decideThinking(a, 'off', a.requestMaxTokens, '甲')).toEqual({ level: 'off' });
    expect(decideThinking(b, 'high', b.requestMaxTokens, '乙')).toMatchObject({ level: 'off', note: expect.stringContaining('不支持推理') });
  });

  it('Anthropic 预算：夹进端点声明的区间与 max_tokens 之内；放不下 1024 就不开', () => {
    const claude = resolveRuntimeModel({ kind: 'anthropic', modelId: 'claude-x' }, catalog);
    expect(decideThinking(claude, 'high', 64_000, 'C')).toEqual({ level: 'high', budgetTokens: 63_999 });
    expect(decideThinking(claude, 'low', 64_000, 'C')).toEqual({ level: 'low', budgetTokens: 8192 });
    expect(decideThinking(claude, 'low', 1_000, 'C')).toMatchObject({ level: 'off', note: expect.stringContaining('1024') });
    // 手动把输出上限改到 1000：planSlot 用的就是它，推理随之关闭
    const small = resolveRuntimeModel({ kind: 'anthropic', modelId: 'claude-x', maxOutputTokens: 1_000 }, catalog);
    expect(planSlot(small, 'low', NO_NEEDS, 'C').thinking.level).toBe('off');
  });

  it('参数类型对不上、协议不发、未确认、自适应模型', () => {
    const gem = resolveRuntimeModel({ kind: 'gemini', modelId: 'gem-v' }, catalog);
    // F01R（D4）：官方 Gemini 上目录只声明档位的型号回到 F01 之前的档位预算表（high = 24576），不再关掉推理
    expect(decideThinking(gem, 'high', 65_536, 'G')).toEqual({ level: 'high', budgetTokens: 24_576 });
    const ollama = resolveRuntimeModel({ kind: 'ollama', modelId: 'shared-model' }, catalog);
    expect(ollama.reasoning).toMatchObject({ state: 'unavailable', transport: 'protocol-missing', param: 'none' });
    expect(decideThinking(ollama, 'high', 8192, 'O').level).toBe('off');
    const relay = resolveRuntimeModel(RELAY, catalog);
    // F01R（A3）：中转上「目录任一家声明支持」不再驱动请求——未确认就不发推理参数，并说明出路
    const relayPlan = decideThinking(relay, 'medium', relay.requestMaxTokens, 'R');
    expect(relayPlan.level).toBe('off');
    expect(relayPlan.note).toContain('未确认');
    expect(relayPlan.note).toContain('手动修正');
    const mystery = resolveRuntimeModel({ kind: 'openai-compat', baseUrl: 'https://relay.example/v1', modelId: 'mystery-9' }, catalog);
    expect(decideThinking(mystery, 'high', 8192, 'M')).toMatchObject({ level: 'off', note: expect.stringContaining('未确认') });
    const manual = resolveRuntimeModel({ kind: 'openai-compat', baseUrl: 'https://relay.example/v1', modelId: 'mystery-9', capabilityOverrides: { reasoning: true } }, catalog);
    expect(decideThinking(manual, 'high', 8192, 'M')).toEqual({ level: 'high' });
    const adaptive = resolveRuntimeModel({ kind: 'anthropic', modelId: 'claude-opus-5-5' }, catalog);
    expect(decideThinking(adaptive, 'high', 128_000, 'X')).toEqual({ level: 'high' });
  });
});

describe('planSlot：接不接得住、工具与图片怎么发', () => {
  it('本轮带图片：不收图片的槽位不接；收图片或未确认的照常', () => {
    const a = resolveRuntimeModel(A, catalog);
    const b = resolveRuntimeModel(B, catalog);
    const relay = resolveRuntimeModel(RELAY, catalog);
    expect(planSlot(b, 'off', { currentImages: 1, historyImages: 0 }, '乙').blocked).toContain('不支持图片输入');
    expect(planSlot(a, 'off', { currentImages: 1, historyImages: 0 }, '甲').blocked).toBeUndefined();
    expect(planSlot(relay, 'off', { currentImages: 2, historyImages: 0 }, 'R').blocked).toBeUndefined();
  });

  it('不支持工具与图片的槽位：不带工具、历史图片改占位、推理关闭，三件事逐条说明', () => {
    const plan = planSlot(resolveRuntimeModel(B, catalog), 'high', { currentImages: 0, historyImages: 2 }, '乙');
    expect(plan).toMatchObject({ maxTokens: 8_000, sendTools: false, imagePlaceholder: true, thinking: { level: 'off' } });
    expect(plan.blocked).toBeUndefined();
    expect(plan.notices).toHaveLength(3);
    expect(plan.notices.join('\n')).toMatch(/推理[\s\S]*工具调用[\s\S]*2 张图片/);
  });

  it('countImageNeeds：最后一条有用户内容的消息算当前轮，工具结果载体不算', () => {
    const img = { type: 'imageData' as const, value: { mimeType: 'image/png', base64: 'x' } };
    const msgs: AgentMessage[] = [
      { role: 'user', parts: [{ type: 'text', value: '看' }, img] },
      { role: 'assistant', parts: [{ type: 'text', value: 'ok' }] },
      { role: 'user', parts: [img, img] },
      { role: 'assistant', parts: [{ type: 'toolUse', value: { toolUseId: 'T', name: 'echo', input: '{}' } }] },
      { role: 'user', parts: [{ type: 'toolResult', value: { toolUseId: 'T', output: 'x', success: true, status: 'success' } }] },
    ];
    expect(countImageNeeds(msgs)).toEqual({ currentImages: 2, historyImages: 1 });
  });
});

describe('构建器按槽位参数发送（缺省时与 F01 之前逐字节相同）', () => {
  const base: StreamRequest = { messages: [{ role: 'user', parts: [{ type: 'text', value: 'hi' }] }], systemPrompt: 's', tools: [], maxTokens: 8000, thinkingLevel: 'medium' };
  it('OpenAI：reasoning_effort 用映射后的档位；没有工具时不写 tools 键（tools: [] 会被 OpenAI 拒绝）', () => {
    const body = buildOpenAIBody({ ...base, thinking: { effort: 'low' } }, 'm');
    expect(body.reasoning_effort).toBe('low');
    expect('tools' in body).toBe(false);
    expect(buildOpenAIBody(base, 'm').reasoning_effort).toBe('medium');
  });
  it('Anthropic / Gemini：预算用槽位核算的值', () => {
    const anthropic = buildAnthropicBody({ ...base, thinking: { budgetTokens: 2048 } }, 'claude-x');
    expect(anthropic.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
    const gemini = buildGeminiBody({ ...base, thinking: { budgetTokens: 1234 } }, 'gem-v') as { generationConfig: { thinkingConfig: unknown } };
    expect(gemini.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 1234, includeThoughts: true });
  });
});
