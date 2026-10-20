/**
 * F02 验收 3 / 阻断 3：约束形态（共享窗口与独立上限）、预算公式与不变量、输出偏好、校准与实测上限、减压先后的判断。
 * 纯函数层的用例；循环与请求体的证据在 request-budget-loop.test.ts。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelCatalog } from '../src/minisd/providers/model-catalog';
import { limitProfile, planSlot, resolveRuntimeModel, type RuntimeModelInput } from '../src/minisd/providers/runtime-model';
import { ANTHROPIC_BUDGET_RULE } from '../src/minisd/providers/anthropic';
import { OPENAI_CHAT_BUDGET_RULE } from '../src/minisd/providers/openai';
import { GEMINI_BUDGET_RULE } from '../src/minisd/providers/gemini';
import {
  calibrationFrom, compactWorthwhile, decideContextAction, fixedCostDominates, measureMessages, needsRelief, orderToolDefinitions,
  outputExhaustedMessage, prunesBeforeSend, resolveOutputPreference, truncatedToolCallNotice, type OutputExhaustedFacts,
} from '../src/minisd/agent/request-budget';
import { pendingSummaryRange } from '../src/minisd/agent/compact';
import {
  DEFAULT_OUTPUT_PREFERENCE, MARGIN_FLOOR, MIN_REQUEST_OUTPUT, buildRequestBudget,
  type BudgetMeasure, type LimitProfile, type RequestBudget,
} from '../src/shared/request-budget';
import type { ContextAction } from '../src/minisd/agent/context-policy';
import type { AgentMessage, AgentToolDefinition, CompactMarker, RawMessage, TokenUsage } from '../src/shared/types';
import type { RuntimeModel } from '../src/shared/runtime-model';
import { EXAMPLE_APIS, catalogFixtureF02, jsonResponse } from './runtime-model-fixture';

let dir: string;
let catalog: ModelCatalog;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dm-budget-'));
  catalog = new ModelCatalog(join(dir, 'catalog.json'), async () => jsonResponse(catalogFixtureF02()));
  await catalog.refresh(true);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const RELAY = 'https://relay.example/v1';
const vendorA = (modelId: string, extra: Partial<RuntimeModelInput> = {}): RuntimeModelInput => ({ kind: 'openai-compat', baseUrl: EXAMPLE_APIS.vendorA, modelId, ...extra });
const relay = (modelId: string, extra: Partial<RuntimeModelInput> = {}): RuntimeModelInput => ({ kind: 'openai-compat', baseUrl: RELAY, modelId, ...extra });
const rtOf = (input: RuntimeModelInput): RuntimeModel => resolveRuntimeModel(input, catalog);

const shared = (window: number, cap: number, extra: Partial<LimitProfile> = {}): LimitProfile =>
  ({ kind: 'shared', inputLimit: window, sharedWindow: window, outputCap: cap, windowKnown: true, authority: 'manual', basis: 'window', note: '', ...extra });
const separate = (inputLimit: number, cap: number, extra: Partial<LimitProfile> = {}): LimitProfile =>
  ({ kind: 'separate', inputLimit, outputCap: cap, windowKnown: true, authority: 'endpoint', basis: 'catalog-input', note: '', ...extra });
const measureOf = (m: Partial<BudgetMeasure>): BudgetMeasure =>
  ({ system: 0, systemStable: m.system ?? 0, tools: 0, toolCount: 0, history: 0, reasoningReplay: 0, media: [], ...m });
type Calibration = RequestBudget['input']['calibration'];
const UNCALIBRATED: Calibration = { ratio: 1, calibrated: false };
function budgetOf(limits: LimitProfile, m: Partial<BudgetMeasure>, o: { preference?: number; source?: 'manual' | 'task' | 'default'; calibration?: Calibration } = {}): RequestBudget {
  return buildRequestBudget({
    slot: { label: 'L', modelId: 'm', key: 'openai-chat:m' }, measure: measureOf(m), limits,
    calibration: o.calibration ?? UNCALIBRATED,
    preference: { tokens: o.preference ?? limits.outputCap, source: o.source ?? 'default' },
  });
}

describe('P1 约束形态：按 adapter 规则与目录资料区分共享窗口与独立上限', () => {
  it('P1 六种配置的 kind / basis / inputLimit', () => {
    expect(limitProfile(rtOf(vendorA('shared-model')))).toMatchObject({ kind: 'shared', basis: 'window', inputLimit: 200_000, sharedWindow: 200_000, outputCap: 32_000, windowKnown: true });
    const ind = limitProfile(rtOf(vendorA('ind-model')));
    expect(ind).toMatchObject({ kind: 'separate', basis: 'catalog-input', inputLimit: 272_000, outputCap: 128_000, windowKnown: true });
    expect('sharedWindow' in ind).toBe(false);
    expect(limitProfile(rtOf(vendorA('both-model')))).toMatchObject({ kind: 'shared', basis: 'catalog-input+window', inputLimit: 180_000, sharedWindow: 200_000, outputCap: 64_000 });
    const gem = limitProfile(rtOf({ kind: 'gemini', modelId: 'gem-v' }));
    expect(gem).toMatchObject({ kind: 'separate', basis: 'adapter-separate', inputLimit: 1_048_576 });
    expect('sharedWindow' in gem).toBe(false);
    // 手动窗口是用户对这个接入的断言：目录的输入上限不再压过它
    expect(limitProfile(rtOf(vendorA('ind-model', { contextWindow: 300_000 })))).toMatchObject({ kind: 'shared', basis: 'window', inputLimit: 300_000, sharedWindow: 300_000 });
    // 窗口没有资料的中转：只按 128K 判水位
    expect(limitProfile(rtOf(relay('unlisted-model')))).toMatchObject({ kind: 'shared', basis: 'window', inputLimit: 128_000, windowKnown: false });
    for (const p of [ind, gem]) expect(p.note).toMatch(/输入上限/);
  });

  it('P1b authority：只有手动填的与当前端点自己记录的原值是硬来源', () => {
    const authorityOf = (input: RuntimeModelInput) => limitProfile(rtOf(input)).authority;
    expect(authorityOf(relay('unlisted-model', { contextWindow: 32_000 }))).toBe('manual');
    expect(authorityOf(vendorA('shared-model'))).toBe('endpoint');
    // 同名型号经中转：窗口来自跨服务商汇总（取被佐证的最小值），有意取低
    expect(authorityOf(relay('shared-model'))).toBe('advisory');
    // 只命中内置族表
    expect(authorityOf(relay('llama-custom-build'))).toBe('advisory');
    // 官方 Anthropic 上被 200K 计法改小的窗口：source 是 endpoint，但带 declared
    const claude = rtOf({ kind: 'anthropic', modelId: 'claude-x' });
    expect(claude.limits.contextWindow).toMatchObject({ value: 200_000, source: 'endpoint', declared: 1_000_000 });
    expect(limitProfile(claude).authority).toBe('advisory');
    expect(authorityOf(relay('unlisted-model'))).toBe('none');
    // 目录给的独立输入上限来自端点自己的记录
    expect(authorityOf(vendorA('ind-model'))).toBe('endpoint');
    expect(authorityOf(relay('ind-model'))).toBe('advisory');
  });

  it('P13 三个 adapter 的规则常量：Anthropic 与 OpenAI 兼容是共享窗口，Gemini 是各有各的上限', () => {
    expect(ANTHROPIC_BUDGET_RULE.window).toBe('shared');
    expect(OPENAI_CHAT_BUDGET_RULE.window).toBe('shared');
    expect(GEMINI_BUDGET_RULE.window).toBe('separate');
    for (const r of [ANTHROPIC_BUDGET_RULE, OPENAI_CHAT_BUDGET_RULE, GEMINI_BUDGET_RULE]) expect(r.note.length).toBeGreaterThan(0);
  });
});

describe('预算公式', () => {
  it('P2 同一份度量：独立上限不随输入收紧输出，共享窗口收紧到剩余空间', () => {
    const ind = limitProfile(rtOf(vendorA('ind-model')));
    const wide = limitProfile(rtOf(vendorA('wide-model')));
    expect(wide).toMatchObject({ kind: 'shared', inputLimit: 400_000, sharedWindow: 400_000, outputCap: 128_000 });
    const task = { preference: 128_000, source: 'task' as const };
    expect(budgetOf(ind, { history: 200_000 }, task).output.requested).toBe(128_000);
    expect(budgetOf(ind, { history: 240_000 }, task).output.requested).toBe(128_000);
    expect(budgetOf(wide, { history: 240_000 }, task).output).toMatchObject({ requested: 124_000, limitedBy: 'window' });
    const full = budgetOf(wide, { history: 350_000 }, task);
    expect(full.output).toMatchObject({ requested: 10_000, limitedBy: 'window' });
    expect(full.status).toBe('tight');
    expect(full.input.tokens + full.output.requested + full.safetyMargin).toBeLessThanOrEqual(400_000);
  });

  it('P3 独立输入上限：输入超过它就是 over，哪怕窗口还有空间', () => {
    const b = budgetOf(limitProfile(rtOf(vendorA('ind-model'))), { history: 280_000 });
    expect(b.status).toBe('over');
    expect(b.reason).toContain('输入上限 272000');
  });

  it('P3b 目录另给输入上限、输入与输出仍共用窗口（catalog-input+window）：over 按输入上限判，不按窗口；输出仍按窗口的剩余空间收紧', () => {
    const both = limitProfile(rtOf(vendorA('both-model')));
    expect(both).toMatchObject({ kind: 'shared', basis: 'catalog-input+window', inputLimit: 180_000, sharedWindow: 200_000, outputCap: 64_000 });
    // 输入 170,000 加余量 18,000 超过输入上限 180,000，但没超过窗口 200,000：按窗口判的话只是 tight，端点却会按输入上限拒绝
    const over = budgetOf(both, { history: 170_000 });
    expect(over.safetyMargin).toBe(18_000);
    expect(over.status).toBe('over');
    expect(over.reason).toContain('180000');
    expect(over.output).toMatchObject({ available: 12_000, requested: 12_000, limitedBy: 'window' });
    // 对照：输入 150,000 放得下输入上限；输出按窗口的剩余空间（200,000 − 150,000 − 18,000）收紧
    const ok = budgetOf(both, { history: 150_000 });
    expect(ok.status).toBe('ok');
    expect(ok.output).toMatchObject({ available: 32_000, requested: 32_000, limitedBy: 'window' });
  });

  it('设计 §4.6 的逐例表', () => {
    expect(budgetOf(shared(200_000, 128_000), { history: 20_000 }, { preference: 65_536 })).toMatchObject({ safetyMargin: 3_000, status: 'ok', output: { available: 128_000, requested: 65_536, limitedBy: 'preference' } });
    expect(budgetOf(shared(64_000, 30_000), { history: 40_100 }, { source: 'manual' })).toMatchObject({ safetyMargin: 6_015, status: 'ok', output: { available: 17_885, requested: 17_885, limitedBy: 'window' } });
    const tight = budgetOf(shared(32_000, 8_192), { history: 26_000 });
    expect(tight).toMatchObject({ safetyMargin: 3_200, status: 'tight', output: { available: 2_800, requested: 2_800, reserve: 8_000, limitedBy: 'window' } });
    expect(tight.reason).toBe('输出空间只剩约 2800，低于预留值 8000：本次 max_tokens 收紧到 2800');
    expect(budgetOf(shared(32_000, 8_192), { history: 26_000 }, { preference: 300, source: 'task' })).toMatchObject({ status: 'ok', output: { requested: 300, limitedBy: 'preference' } });
    expect(budgetOf(separate(40_000, 8_192), { history: 36_000 })).toMatchObject({ safetyMargin: 4_000, status: 'ok', output: { available: 8_192, requested: 8_192, limitedBy: 'model' } });
  });

  it('P4 性质测试：随机 2000 组都满足 I-B1 – I-B6', () => {
    // 固定种子的线性同余：失败可复现
    let seed = 20261004;
    const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const int = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
    const pick = <T,>(xs: readonly T[]): T => xs[int(0, xs.length - 1)];
    for (let n = 0; n < 2000; n++) {
      const window = pick([8_000, 32_000, 64_000, 128_000, 200_000, 1_000_000]);
      const cap = int(1, Math.max(1, Math.floor(window * 3 / 4)));
      const kind = pick(['shared', 'shared', 'separate'] as const);
      const inputLimit = rnd() < 0.3 ? int(1_000, window) : window;
      const limits: LimitProfile = {
        kind, inputLimit, ...(kind === 'shared' ? { sharedWindow: window } : {}), outputCap: cap,
        windowKnown: rnd() < 0.85, authority: pick(['manual', 'endpoint', 'advisory', 'none'] as const), basis: 'window', note: '',
      };
      const scaleOf = (): number => int(0, Math.floor(window * 1.6));
      const system = rnd() < 0.5 ? int(0, 3_000) : scaleOf();
      const m: BudgetMeasure = {
        system, systemStable: int(0, system), tools: rnd() < 0.5 ? int(0, 3_000) : scaleOf(), toolCount: int(0, 80),
        history: rnd() < 0.5 ? int(0, 3_000) : scaleOf(), reasoningReplay: rnd() < 0.7 ? 0 : int(0, 20_000),
        media: Array.from({ length: int(0, 3) }, () => ({ kind: 'image' as const, tokens: int(16, 4_784), basis: pick(['formula', 'upper-bound', 'default'] as const) })),
      };
      const calibrated = rnd() < 0.5;
      const calibration: Calibration = {
        ratio: calibrated ? 0.5 + rnd() * 1.5 : 1, calibrated,
        ...(rnd() < 0.3 ? { observedMaxInput: int(1, Math.floor(window * 1.5)) } : {}),
      };
      const source = pick(['manual', 'task', 'default'] as const);
      const preference = { tokens: rnd() < 0.2 ? int(1, Math.min(cap, 1_023)) : int(1, cap), source };
      const args = { slot: { label: 'L', modelId: 'm', key: 'k' }, measure: m, limits, calibration, preference };
      const b = buildRequestBudget(args);
      const where = JSON.stringify(args);
      const c = b.input.components;
      // I-B1
      expect(b.input.tokens, where).toBe(c.system + c.tools + c.history + c.reasoningReplay + c.media);
      expect(b.input.systemStable + b.input.systemDynamic, where).toBe(c.system);
      // I-B2
      expect(b.output.requested, where).toBeGreaterThanOrEqual(1);
      expect(b.output.requested, where).toBeLessThanOrEqual(b.output.preference);
      expect(b.output.preference, where).toBeLessThanOrEqual(b.output.cap);
      // I-B3
      if (b.limits.kind === 'shared' && b.limits.windowKnown && (b.status === 'ok' || b.status === 'tight')) {
        expect(b.input.tokens + b.output.requested + b.safetyMargin, where).toBeLessThanOrEqual(b.limits.sharedWindow!);
      }
      // I-B4
      if (b.limits.kind === 'separate' || !b.limits.windowKnown) {
        const other = buildRequestBudget({ ...args, measure: { ...m, history: m.history + int(1, window) } });
        expect(other.output.requested, where).toBe(b.output.requested);
        expect(b.output.requested, where).toBe(preference.tokens);
      }
      // I-B5（下界在这里独立重算）
      const fixedLow = Math.floor((m.system + m.tools) * Math.min(0.70, calibrated ? 0.90 * calibration.ratio : 0.70));
      const mustBlock = b.limits.windowKnown && (limits.authority === 'manual' || limits.authority === 'endpoint') && fixedLow >= inputLimit;
      expect(b.status === 'blocked', where).toBe(mustBlock);
      // I-B6
      if (calibration.observedMaxInput !== undefined && calibration.observedMaxInput >= inputLimit) {
        expect(b.limits.windowKnown, where).toBe(false);
        expect(b.limits.observedAbove, where).toBe(calibration.observedMaxInput);
        expect(b.status, where).toBe('ok');
      } else {
        expect(b.limits, where).toEqual(limits);
      }
      if (b.status === 'ok') expect('reason' in b, where).toBe(false); else expect(b.reason, where).toBeTruthy();
    }
  });

  it('P5 输出偏好：默认 65,536、手动值、任务偏好、推理预算加在偏好之上；任务偏好低于 1,024 时不被下限抬高', () => {
    const rt = (cap: number, source: 'manual' | 'endpoint' = 'endpoint') =>
      ({ requestMaxTokens: cap, limits: { maxOutputTokens: { value: cap, source } } }) as unknown as RuntimeModel;
    expect(DEFAULT_OUTPUT_PREFERENCE).toBe(65_536);
    expect(resolveOutputPreference(rt(128_000))).toEqual({ tokens: 65_536, source: 'default' });
    expect(resolveOutputPreference(rt(100_000, 'manual'))).toEqual({ tokens: 100_000, source: 'manual' });
    expect(resolveOutputPreference(rt(128_000), { task: 4_000 })).toEqual({ tokens: 4_000, source: 'task' });
    expect(resolveOutputPreference(rt(128_000), { task: 300 })).toEqual({ tokens: 300, source: 'task' });
    expect(resolveOutputPreference(rt(8_000))).toEqual({ tokens: 8_000, source: 'default' });
    expect(resolveOutputPreference(rt(128_000), { thinkingBudget: 32_768 })).toEqual({ tokens: 98_304, source: 'default' });
    // 任务偏好大于模型上限：夹到上限；手动最大输出下任务偏好仍然优先
    expect(resolveOutputPreference(rt(8_000), { task: 50_000 })).toEqual({ tokens: 8_000, source: 'task' });
    expect(resolveOutputPreference(rt(100_000, 'manual'), { task: 2_000 })).toEqual({ tokens: 2_000, source: 'task' });
    // 「任务 300」：剩余空间 5,000 与 100 时发出的都是 300
    const roomy = budgetOf(shared(32_000, 8_192), { history: 23_800 }, { preference: 300, source: 'task' });
    expect(roomy.output.available).toBe(5_000);
    expect(roomy.output.requested).toBe(300);
    const cramped = budgetOf(shared(32_000, 8_192), { history: 28_700 }, { preference: 300, source: 'task' });
    expect(cramped.output.available).toBe(100);
    expect(cramped.output.requested).toBe(300);
    expect(MIN_REQUEST_OUTPUT).toBe(1_024);
  });

  it('P6 窗口没有资料：状态恒为 ok，max_tokens 等于偏好，与输入无关', () => {
    const limits = limitProfile(rtOf(relay('unlisted-model')));
    for (const history of [10, 100_000, 500_000]) {
      const b = budgetOf(limits, { history }, { preference: 8_192 });
      expect(b.status).toBe('ok');
      expect(b.output.requested).toBe(8_192);
    }
  });

  it('P7 blocked 只看固定开销的估算下界、只认硬来源、下界不随校准变严', () => {
    const manual = shared(32_000, 8_192, { authority: 'manual' });
    const advisory = shared(32_000, 8_192, { authority: 'advisory' });
    const cases: Partial<BudgetMeasure>[] = [
      { system: 50_000, tools: 500 },          // 下界 35,350
      { system: 400, tools: 100, history: 50_000 },   // 同样的总量，主要是历史
      { system: 43_500, tools: 500 },          // 下界 30,800 < 32,000
    ];
    expect(cases.map(m => budgetOf(manual, m).status)).toEqual(['blocked', 'over', 'over']);
    expect(cases.map(m => budgetOf(advisory, m).status)).toEqual(['over', 'over', 'over']);
    const blocked = budgetOf(manual, cases[0]);
    expect(blocked.reason).toBe('系统提示约 50000、工具定义约 500（0 个），按估算下界 35350 已不小于上下文窗口 32000');
    expect(blocked.output.requested).toBe(1_024);
    expect(budgetOf(advisory, cases[0]).output).toMatchObject({ requested: 1_024, limitedBy: 'floor' });
    // 已校准：ρ = 1.0 时下界仍按 0.70（不变严）；ρ = 1.5 仍按 0.70；ρ = 0.6 时下界跟着降到 0.54
    const cal = (ratio: number): Calibration => ({ ratio, calibrated: true });
    expect(budgetOf(manual, { system: 43_500, tools: 500 }, { calibration: cal(1.0) }).status).toBe('over');
    expect(budgetOf(manual, { system: 29_500, tools: 500 }, { calibration: cal(1.5) }).status).toBe('over');
    expect(budgetOf(manual, { system: 59_500, tools: 500 }, { calibration: cal(0.6) }).status).toBe('blocked');
  });

  it('P9 校准系数只缩放文本四项，图片不缩放；已校准时余量按 5%', () => {
    const media = [{ kind: 'image' as const, tokens: 1_296, basis: 'formula' as const }];
    const m = { system: 1_001, systemStable: 501, tools: 2_001, history: 30_001, reasoningReplay: 4_001, media };
    const b = budgetOf(shared(1_000_000, 64_000), m, { calibration: { ratio: 1.5, calibrated: true } });
    expect(b.input.components).toEqual({ system: 1_502, tools: 3_002, history: 45_002, reasoningReplay: 6_002, media: 1_296 });
    expect(b.input.systemStable).toBe(752);
    expect(b.input.systemDynamic).toBe(750);
    expect(b.input.raw).toEqual({ text: 37_004, media: 1_296 });
    expect(b.safetyMargin).toBe(Math.ceil(b.input.tokens * 0.05));
    expect(budgetOf(shared(1_000_000, 64_000), m).safetyMargin).toBe(Math.ceil((37_004 + 1_296) * 0.15));
    expect(b.input.mediaBasis).toBe('formula');
    expect(b.input.imageCount).toBe(1);
  });

  it('P14 实测规则：端点已经收下过不小于资料上限的输入，不再据此拒发或收紧输出', () => {
    const manual = shared(32_000, 8_192, { authority: 'manual' });
    const fixed = { system: 50_000, tools: 500 };
    const withObs = (observedMaxInput?: number) => budgetOf(manual, fixed, { calibration: { ratio: 1, calibrated: false, ...(observedMaxInput !== undefined ? { observedMaxInput } : {}) } });
    for (const obs of [undefined, 31_999]) {
      const b = withObs(obs);
      expect(b.status, String(obs)).toBe('blocked');
      expect(b.limits.windowKnown, String(obs)).toBe(true);
      expect('observedAbove' in b.limits, String(obs)).toBe(false);
    }
    for (const obs of [32_000, 44_000]) {
      const b = withObs(obs);
      expect(b.status, String(obs)).toBe('ok');
      expect(b.limits.windowKnown, String(obs)).toBe(false);
      expect(b.limits.observedAbove, String(obs)).toBe(obs);
      expect(b.output.requested, String(obs)).toBe(8_192);
      expect(b.output.limitedBy, String(obs)).toBe('model');
    }
  });

  it('P15 fixedCostDominates：分清固定开销放不下与对话过长', () => {
    const manual = shared(32_000, 8_192);
    expect(MARGIN_FLOOR).toBe(1_024);
    expect(fixedCostDominates(budgetOf(manual, { system: 43_500, tools: 500, history: 10 }))).toBe(true);
    expect(fixedCostDominates(budgetOf(manual, { system: 31_000, tools: 500, history: 3_000 }))).toBe(true);
    expect(fixedCostDominates(budgetOf(manual, { system: 1_500, tools: 500, history: 40_000 }))).toBe(false);
    expect(fixedCostDominates(budgetOf(shared(32_000, 8_192, { windowKnown: false, authority: 'none' }), { system: 43_500, tools: 500, history: 10 }))).toBe(false);
  });
});

describe('校准与实测上限（只读落库的历史）', () => {
  let n = 0;
  const RT = { protocol: 'openai-chat' as const, modelId: 'unlisted-model', instanceId: 'inst-1' };
  const SOURCE = { by: 'provider' as const, protocol: 'openai-chat' as const, modelId: 'unlisted-model', instanceId: 'inst-1' };
  const msg = (tokenUsage: TokenUsage | undefined, role: 'user' | 'assistant' = 'assistant'): RawMessage => ({
    id: `M${++n}`, sessionId: 's', role, parts: [{ type: 'text', value: 'x' }], createdAt: n, updatedAt: n, sortOrder: n, streamInterruptCount: 0,
    ...(tokenUsage ? { tokenUsage } : {}),
  });
  const usage = (inputTokens: number, text: number | undefined, extra: Partial<TokenUsage> = {}): TokenUsage => ({
    inputTokens, outputTokens: 10, v: 2, source: SOURCE,
    ...(text !== undefined ? { estimate: { text, media: 0, input: text } } : {}), ...extra,
  });

  it('P8 校准系数：只采用同口径、无图片、文本估计 ≥ 2000、比例在 [0.5, 2] 的最近一条', () => {
    expect(calibrationFrom([], RT)).toEqual({ ratio: 1, calibrated: false });
    // 文本估计不足 2000：不采用（但计入实测上限）
    expect(calibrationFrom([msg(usage(1_300, 1_000))], RT)).toEqual({ ratio: 1, calibrated: false, observedMaxInput: 1_300 });
    const good = msg(usage(2_600, 2_000));
    expect(calibrationFrom([good], RT)).toEqual({ ratio: 1.3, calibrated: true, last: { estimated: 2_000, actual: 2_600, errorPct: 23 }, observedMaxInput: 2_600 });
    // 更近的记录都不合格：逐条跳过，继续往前找到 good
    const skipped = [
      msg(usage(3_000, 2_500, { estimate: { text: 2_500, media: 1_296, input: 3_796 } })),                 // 带图片
      msg(usage(3_000, 2_500, { source: { ...SOURCE, modelId: 'other-model' } })),                          // 型号不同
      msg(usage(3_000, 2_500, { source: { ...SOURCE, protocol: 'anthropic' } })),                           // 协议不同
      msg(usage(3_000, 2_500, { source: { by: 'provider', modelId: 'unlisted-model' } })),                  // source 不带 protocol
      msg({ ...usage(0, 2_500), unreported: ['input'] }),                                                   // 服务商没报输入
      msg({ inputTokens: 3_000, outputTokens: 10 }),                                                        // 旧记录（没有 v: 2）
      msg(usage(12_500, 2_500)),                                                                            // 比例 5：丢弃，不夹到 2
      msg(usage(1_000, 2_500)),                                                                             // 比例 0.4：丢弃
      msg(undefined), msg(undefined, 'user'),
    ];
    const c = calibrationFrom([good, ...skipped], RT);
    expect(c.calibrated).toBe(true);
    expect(c.ratio).toBe(1.3);
    expect(c.last).toEqual({ estimated: 2_000, actual: 2_600, errorPct: 23 });
    // 估计与实测的误差按「发送时采用的估计」算：上一次已校准时 estimate.input 不等于 estimate.text
    const recal = msg(usage(4_000, 2_000, { estimate: { text: 2_000, media: 0, input: 3_000 } }));
    expect(calibrationFrom([good, recal], RT)).toMatchObject({ ratio: 2, last: { estimated: 3_000, actual: 4_000, errorPct: 25 } });
  });

  it('P8b 实测上限：同口径、同配置实例的 v:2 记录里最大的输入；带图片的、取消时落下的也算；旧记录与别的接入不算', () => {
    const history = [
      msg(usage(9_000, 8_000)),
      msg(usage(44_000, 30_000, { estimate: { text: 30_000, media: 5_000, input: 35_000 } })),   // 带图片
      msg(usage(12_000, undefined)),                                                              // 取消时落下：没有 estimate
      msg(usage(90_000, 60_000, { source: { ...SOURCE, instanceId: 'inst-other' } })),            // 别的配置实例
      msg({ inputTokens: 99_000, outputTokens: 10 }),                                             // 旧记录
    ];
    expect(calibrationFrom(history, RT).observedMaxInput).toBe(44_000);
    // 任一边没有实例 id 时不比
    expect(calibrationFrom(history, { protocol: 'openai-chat', modelId: 'unlisted-model' }).observedMaxInput).toBe(90_000);
    expect(calibrationFrom([msg({ inputTokens: 99_000, outputTokens: 10 })], RT)).toEqual({ ratio: 1, calibrated: false });
  });

  it('P8c 口径版本单独把关：来源与估计都对得上、只是没有 v: 2 的记录（别的版本写的），既不用来校准，也不计入实测上限', () => {
    // 上面两条用例里的旧记录连来源都没有，光靠「口径对不上」就被跳过了；这里的记录只差 v 这一项
    const noVersion = (inputTokens: number, text: number): TokenUsage =>
      ({ inputTokens, outputTokens: 10, source: SOURCE, estimate: { text, media: 0, input: text } });
    expect(calibrationFrom([msg(noVersion(3_000, 2_500))], RT)).toEqual({ ratio: 1, calibrated: false });
    // 比例 1.65 落在 [0.5, 2] 里、输入也比合格的那条大：少了版本这一关就会被采用
    const good = msg(usage(2_600, 2_000));
    expect(calibrationFrom([good, msg(noVersion(99_000, 60_000))], RT))
      .toEqual({ ratio: 1.3, calibrated: true, last: { estimated: 2_000, actual: 2_600, errorPct: 23 }, observedMaxInput: 2_600 });
  });
});

describe('减压先后、工具顺序、推理预算', () => {
  it('P10 decideContextAction：修剪是第一道，付费的压缩只在可压部分够大时才发', () => {
    const b = (status: RequestBudget['status'], history: number): RequestBudget =>
      ({ status, input: { components: { system: 0, tools: 0, history, reasoningReplay: 0, media: 0 } } }) as unknown as RequestBudget;
    const rows: [ContextAction, RequestBudget['status'], number][] = [
      ['compact', 'ok', 10_000], ['compact', 'ok', 2_000], ['offload', 'ok', 10_000], ['none', 'tight', 10_000], ['none', 'over', 2_000], ['none', 'ok', 10_000],
    ];
    expect(rows.map(([tier, status, h]) => decideContextAction(tier, b(status, h)))).toEqual(['compact', 'offload', 'offload', 'offload', 'offload', 'none']);
    expect(rows.map(([, status, h]) => compactWorthwhile(b(status, h)))).toEqual([false, false, false, true, false, false]);
    expect(rows.map(([, status, h]) => needsRelief(b(status, h)))).toEqual([false, false, false, true, true, false]);
    // 空闲推算要不要按修剪后的历史算：循环会先修剪的（第 ① 步），以及压缩档上余量不足的（压缩没有产出时的第 ③ 步）
    const more: typeof rows = [...rows, ['compact', 'tight', 10_000], ['compact', 'over', 2_000], ['offload', 'tight', 10_000]];
    expect(more.map(([tier, status, h]) => prunesBeforeSend(tier, b(status, h)))).toEqual([false, true, true, true, true, false, true, true, true]);
  });

  it('P10b pendingSummaryRange：summarize 这一次会取材的区间（双轨锚点、接着旧 marker、没有新增可摘）', () => {
    let n = 0;
    const msg = (role: 'user' | 'assistant', parts: RawMessage['parts']): RawMessage =>
      ({ id: `H${++n}`, sessionId: 's', role, parts, createdAt: n, updatedAt: n, sortOrder: n, streamInterruptCount: 0 });
    const ask = (): RawMessage => msg('user', [{ type: 'text', value: 'q' }]);
    const round = (): RawMessage[] => [
      msg('assistant', [{ type: 'toolUse', value: { toolUseId: `T${n}`, name: 'echo', input: '{}' } }]),
      msg('user', [{ type: 'toolResult', value: { toolUseId: `T${n - 1}`, output: 'ok', success: true, status: 'success' } }]),
    ];
    const marker = (lastCompactedMessageId: string, summary = 'S'): CompactMarker =>
      ({ id: 'K', sessionId: 's', summary, lastCompactedMessageId, createdAt: 1_000 });
    // 单个用户回合：不足 30 条没有可摘；满 30 条按「保留最近 14 条」取
    const single = [ask(), ...Array.from({ length: 15 }, round).flat()];
    expect(single).toHaveLength(31);
    expect(pendingSummaryRange(single.slice(0, 29), undefined)).toBeUndefined();
    expect(pendingSummaryRange(single, undefined)).toEqual({ from: 0, to: 16, rule: 'recent-messages' });
    // 接着旧 marker：只取它锚点之后的增量；锚点已经追上规则锚点时没有新增可摘
    expect(pendingSummaryRange(single, marker(single[10].id))).toEqual({ from: 11, to: 16, rule: 'recent-messages' });
    expect(pendingSummaryRange(single, marker(single[16].id))).toBeUndefined();
    // 代表不了内容的旧 marker 当作没有：从头取材
    expect(pendingSummaryRange(single, marker(single[16].id, '[摘要为空]'))).toEqual({ from: 0, to: 16, rule: 'recent-messages' });
    // 三个以上真实用户回合：锚点在倒数第 3 个用户回合之前
    const multi = [ask(), ...round(), ask(), ...round(), ask(), ...round(), ask()];
    expect(pendingSummaryRange(multi, undefined)).toEqual({ from: 0, to: 2, rule: 'recent-turns' });
  });

  it('P10c measureMessages：一段消息在请求里占多少，与预算同一把尺（协议构建器 + 校准系数）；DeepSeek V4 的回放推理计入', () => {
    const text = 'lorem ipsum dolor sit amet '.repeat(400);
    const messages: AgentMessage[] = [
      { role: 'user', parts: [{ type: 'text', value: text }] },
      { role: 'assistant', parts: [{ type: 'text', value: 'ok' }], reasoningContent: text },
    ];
    const plain = rtOf(relay('unlisted-model'));
    const v4 = rtOf(relay('deepseek-v4-pro'));
    expect(measureMessages(plain, [], [])).toBe(0);
    const base = measureMessages(plain, messages, []);
    expect(base).toBeGreaterThan(2_700);
    expect(base).toBeLessThan(2_800);
    // V4 族把推理原样回放：同一段消息多出一份推理
    expect(measureMessages(v4, messages, [])).toBeGreaterThan(base + 2_600);
    // 同口径的实测样本把估计按系数放大
    const sample: RawMessage = {
      id: 'U1', sessionId: 's', role: 'assistant', parts: [{ type: 'text', value: 'x' }], createdAt: 1, updatedAt: 1, sortOrder: 1, streamInterruptCount: 0,
      tokenUsage: { inputTokens: 6_000, outputTokens: 1, v: 2, source: { by: 'provider', protocol: 'openai-chat', modelId: 'unlisted-model' }, estimate: { text: 4_000, media: 0, input: 4_000 } },
    };
    expect(measureMessages(plain, messages, [sample])).toBe(Math.ceil(base * 1.5));
  });

  it('P13 截断说明：工具调用被截断的提示只为 F02 自己造成的截断发；正文之前就用完额度的错误说明按原因给出路', () => {
    const o = (limitedBy: RequestBudget['output']['limitedBy'], preferenceSource: RequestBudget['output']['preferenceSource'] = 'default') =>
      ({ requested: 4_321, limitedBy, preferenceSource });
    const space = '主力 这次输出被 max_tokens 截断：上下文剩余空间不足，max_tokens 已收紧，工具调用的参数可能不完整。可新建会话，或等下一轮压缩后重试';
    const quota = '主力 这次输出被 max_tokens 截断：单次请求按默认额度申请输出，工具调用的参数可能不完整。需要更长的单次输出时，可在「设置 → 模型 → 编辑 → 手动修正」填写最大输出';
    expect(truncatedToolCallNotice('主力', o('window'))).toBe(space);
    expect(truncatedToolCallNotice('主力', o('floor'))).toBe(space);
    expect(truncatedToolCallNotice('主力', o('preference', 'default'))).toBe(quota);
    for (const n of [space, quota]) expect(n).not.toMatch(/\d/);
    expect(truncatedToolCallNotice('主力', o('preference', 'task'))).toBeUndefined();
    expect(truncatedToolCallNotice('主力', o('manual', 'manual'))).toBeUndefined();
    expect(truncatedToolCallNotice('主力', o('model'))).toBeUndefined();

    const head = '主力 这次输出被 max_tokens 截断，没有产出正文：';
    const spent = '输出额度（max_tokens 4321）在正文之前就用完了，多为推理占用。';
    type By = RequestBudget['output']['limitedBy'];
    type Source = RequestBudget['output']['preferenceSource'];
    /** 出路那一段（服务商没报用量时的说明固定是 spent）。 */
    const tail = (limitedBy: By, source: Source | undefined, facts: OutputExhaustedFacts): string => {
      const m = outputExhaustedMessage('主力', o(limitedBy, source), facts);
      expect(m.startsWith(head + spent), limitedBy).toBe(true);
      expect(m).not.toContain('空响应');
      return m.slice((head + spent).length);
    };
    // 这次请求带了推理参数：调低推理档位是一条出路
    const sent = (limitedBy: By, source?: Source, capIsFallback = false): string => tail(limitedBy, source, { thinkingSent: true, capIsFallback });
    expect(sent('window')).toBe('上下文剩余空间不足，这次的 max_tokens 是收紧过的；可新建会话，或调低推理档位后重发');
    expect(sent('floor')).toBe(sent('window'));
    expect(sent('preference', 'default')).toBe('可调低推理档位后重发；需要更长的单次输出时，在「设置 → 模型 → 编辑 → 手动修正」填写最大输出');
    expect(sent('preference', 'task')).toBe('可调低推理档位，或调高这次任务指定的输出额度后重发');
    expect(sent('manual', 'manual')).toBe('可调低推理档位，或调高手动填写的最大输出后重发');
    expect(sent('model')).toBe('可调低推理档位后重发，或换用输出上限更大的模型');
    expect(sent('model', 'default', true)).toBe('可调低推理档位后重发；这个输出上限是目录没有可用记录时的兜底值，确认模型的真实上限后可在「设置 → 模型 → 编辑 → 手动修正」填写最大输出，或换用模型');
    // 这次请求没带推理参数（档位是关，或这个槽位的推理能力未确认所以没发）：照「调低推理档位」做，重发的请求与这一次逐字节相同——不提它
    const quiet = (limitedBy: By, source?: Source, capIsFallback = false): string => {
      const t = tail(limitedBy, source, { thinkingSent: false, capIsFallback });
      expect(t, limitedBy).not.toContain('推理档位');
      return t;
    };
    expect(quiet('window')).toBe('上下文剩余空间不足，这次的 max_tokens 是收紧过的；可新建会话，或换用上下文窗口更大的模型');
    expect(quiet('floor')).toBe(quiet('window'));
    expect(quiet('preference', 'default')).toBe('这次按默认额度申请输出；需要更长的单次输出时，在「设置 → 模型 → 编辑 → 手动修正」填写最大输出');
    expect(quiet('preference', 'task')).toBe('可调高这次任务指定的输出额度后重发');
    expect(quiet('manual', 'manual')).toBe('可调高手动填写的最大输出后重发');
    // 上限是兜底值（目录没有这个型号的可用记录）：出路是手动填写最大输出，或换用模型
    expect(quiet('model', 'default', true)).toBe('这个输出上限是目录没有可用记录时的兜底值，确认模型的真实上限后可在「设置 → 模型 → 编辑 → 手动修正」填写最大输出，或换用模型');
    expect(quiet('model')).toBe('这已是该模型的输出上限，可换用输出上限更大的模型');

    // 服务商报了用量：照实写数字，不只按收尾原因推断
    const withUsage = (usage: OutputExhaustedFacts['usage'], limitedBy: By = 'model'): string =>
      outputExhaustedMessage('主力', o(limitedBy), { thinkingSent: false, capIsFallback: true, usage });
    const fallbackWay = quiet('model', 'default', true);
    // 额度确实用完了，而且单列了推理
    expect(withUsage({ outputTokens: 4_321, reasoningTokens: 4_300 }))
      .toBe(`${head}输出额度（max_tokens 4321）在正文之前就用完了（服务商报告这次输出 4321，其中推理 4300）。${fallbackWay}`);
    // 用完了但没有单列推理：仍是推断，把报告的数字附上
    expect(withUsage({ outputTokens: 4_000 }))
      .toBe(`${head}输出额度（max_tokens 4321）在正文之前就用完了，多为推理占用（服务商报告这次输出 4000，没有单列推理）。${fallbackWay}`);
    // 报告的输出远低于这次的 max_tokens（不到一半）：不说「额度用完了」，也不让人去调大额度
    const low = withUsage({ outputTokens: 40, reasoningTokens: 12 });
    expect(low).toBe(`${head}服务商报告这次输出 40，其中推理 12，远低于这次的 max_tokens 4321：截断未必是这个额度造成的，端点自己的输出上限可能更小，或者它没有把推理计入输出。`
      + '可重试一次；仍然如此时换用模型，或在「设置 → 模型 → 编辑 → 手动修正」核对该接入的上下文窗口与最大输出');
    expect(low).not.toContain('用完了');
    expect(outputExhaustedMessage('主力', o('manual', 'manual'), { thinkingSent: true, capIsFallback: false, usage: { outputTokens: 2_160 } }))
      .toContain('可调低推理档位后重发；仍然如此时换用模型');
    // 恰好一半算用完；输出一项没报（unreported）等于没有用量
    expect(withUsage({ outputTokens: 2_161 })).toContain('在正文之前就用完了');
    expect(withUsage({ outputTokens: 0, unreported: ['output'] })).toBe(`${head}${spent}${fallbackWay}`);
  });

  it('P16 截断说明（R2-1）：输出上限是按本配置手动窗口的 3/4 封顶出来的，不说成模型自己的上限；出路是手动填写最大输出或调大手动窗口', () => {
    const o = (limitedBy: RequestBudget['output']['limitedBy'], preferenceSource: RequestBudget['output']['preferenceSource'] = 'default') =>
      ({ requested: 24_000, limitedBy, preferenceSource });
    const spent = '主力 这次输出被 max_tokens 截断，没有产出正文：输出额度（max_tokens 24000）在正文之前就用完了，多为推理占用。';
    const windowWay = '这个输出上限不是模型自己的上限，是按本配置手动填写的上下文窗口的 3/4 计的；'
      + '需要更长的单次输出时，可在「设置 → 模型 → 编辑 → 手动修正」填写最大输出，或在确认该接入的窗口更大后调大手动填写的上下文窗口';
    // 这次请求没带推理参数：只有这两条出路
    const quiet = outputExhaustedMessage('主力', o('model'), { thinkingSent: false, capIsFallback: false, capFromManualWindow: true });
    expect(quiet).toBe(spent + windowWay);
    expect(quiet).not.toContain('这已是该模型的输出上限');
    expect(quiet).not.toContain('换用输出上限更大的模型');
    expect(quiet).not.toContain('推理档位');
    // 带了推理参数：调低推理档位排在前面，后面仍是这两条
    const sent = outputExhaustedMessage('主力', o('model'), { thinkingSent: true, capIsFallback: false, capFromManualWindow: true });
    expect(sent).toBe(`${spent}可调低推理档位后重发；${windowWay}`);
    expect(sent).not.toContain('换用输出上限更大的模型');
    // 只在 max_tokens 就是这个上限（limitedBy 为 model）时才说：别的原因各有各的出路，不受这件事影响
    const others: [RequestBudget['output']['limitedBy'], RequestBudget['output']['preferenceSource']][] =
      [['window', 'default'], ['floor', 'default'], ['preference', 'default'], ['preference', 'task'], ['manual', 'manual']];
    for (const [limitedBy, source] of others) {
      for (const thinkingSent of [false, true]) {
        expect(outputExhaustedMessage('主力', o(limitedBy, source), { thinkingSent, capIsFallback: false, capFromManualWindow: true }), `${limitedBy}/${source}`)
          .toBe(outputExhaustedMessage('主力', o(limitedBy, source), { thinkingSent, capIsFallback: false }));
      }
    }
    // 对照：上限是目录记录原样采用的（没有被手动窗口封顶）——仍是模型自己的上限
    expect(outputExhaustedMessage('主力', o('model'), { thinkingSent: false, capIsFallback: false, capFromManualWindow: false }))
      .toBe(`${spent}这已是该模型的输出上限，可换用输出上限更大的模型`);
  });

  it('P16b 解析结果记下「输出上限是按手动窗口的 3/4 封顶出来的」（R2-1）：被挤掉的端点记录与佐证值都带，其余来源不带', () => {
    // 收录端点上目录有记录的型号（记录：窗口 200,000 / 输出 32,000）、手动窗口 32,000、没填最大输出：端点记录被手动窗口挤掉
    const squeezed = rtOf(vendorA('shared-model', { contextWindow: 32_000 }));
    expect(squeezed.limits.maxOutputTokens).toMatchObject({ value: 24_000, source: 'endpoint', declared: 32_000, cappedBy: 'manual-window' });
    expect(squeezed.requestMaxTokens).toBe(24_000);
    // 中转（没有端点记录）：被挤掉的是佐证值
    const relayed = rtOf(relay('shared-model', { contextWindow: 8_000 }));
    expect(relayed.limits.maxOutputTokens).toMatchObject({ value: 6_000, source: 'aggregate', declared: 8_000, cappedBy: 'manual-window' });
    // 不带的：目录记录原样采用（没填窗口 / 手动窗口放得下）、手动填了最大输出、目录没有记录时的兜底值（含小窗口上按 3/4 算的兜底值——那是没有资料）
    const plain: RuntimeModelInput[] = [
      vendorA('shared-model'),
      vendorA('shared-model', { contextWindow: 64_000 }),
      vendorA('shared-model', { contextWindow: 32_000, maxOutputTokens: 30_000 }),
      relay('unlisted-model', { contextWindow: 64_000 }),
      relay('unlisted-model', { contextWindow: 8_000 }),
    ];
    for (const input of plain) expect('cappedBy' in rtOf(input).limits.maxOutputTokens, JSON.stringify(input)).toBe(false);
    expect(rtOf(plain[4])).toMatchObject({ requestMaxTokens: 6_000, limits: { maxOutputTokens: { source: 'none' } } });
  });

  it('P11 orderToolDefinitions：内置工具保持注册序，MCP 工具按名字排在后面', () => {
    const def = (name: string): AgentToolDefinition => ({ name, description: '', parameters: {}, required: [] });
    const names = (xs: string[]) => orderToolDefinitions(xs.map(def)).map(d => d.name);
    expect(names(['mcp__b__x', 'file_read', 'mcp__a__y', 'shell_execute'])).toEqual(['file_read', 'shell_execute', 'mcp__a__y', 'mcp__b__x']);
    expect(names(['mcp__a__y', 'shell_execute', 'mcp__b__x', 'file_read'])).toEqual(['shell_execute', 'file_read', 'mcp__a__y', 'mcp__b__x']);
  });

  it('P12 planSlot 的第五个参数：推理预算按收紧后的 max_tokens 算；放不下时的说明是不含数字的固定句', () => {
    const rt = rtOf({ kind: 'anthropic', modelId: 'claude-x' });
    const needs = { currentImages: 0, historyImages: 0 };
    expect(rt.requestMaxTokens).toBe(64_000);
    expect(planSlot(rt, 'high', needs, '主力')).toMatchObject({ maxTokens: 64_000, thinking: { level: 'high', budgetTokens: 63_999 } });
    expect(planSlot(rt, 'high', needs, '主力', 20_000)).toMatchObject({ maxTokens: 20_000, thinking: { level: 'high', budgetTokens: 19_999 } });
    // 被剩余空间收紧的值：预算给可见输出留底——最小输出 1,024；空间连两倍最小输出都不到时留一半
    const tight = (maxTokens: number) => planSlot(rt, 'high', needs, '主力', maxTokens, { spaceLimited: true }).thinking;
    expect(MIN_REQUEST_OUTPUT).toBe(1_024);
    expect(tight(20_000)).toEqual({ level: 'high', budgetTokens: 18_976 });
    expect(tight(2_048)).toEqual({ level: 'high', budgetTokens: 1_024 });
    // 留一半之后放不下 Anthropic 的最小预算 1,024：不开推理，说明仍是不含数字的固定句
    expect(tight(2_046)).toEqual({ level: 'off', note: '主力 的上下文剩余空间容不下最小推理预算，本轮未开启推理' });
    // 档位预算本来就在留底之内的不受影响
    expect(planSlot(rt, 'low', needs, '主力', 20_000, { spaceLimited: true }).thinking).toEqual({ level: 'low', budgetTokens: 8_192 });
    // 没给 max_tokens 时这个开关不起作用（按模型上限算的计划与以前相同）
    expect(planSlot(rt, 'high', needs, '主力', undefined, { spaceLimited: true }).thinking).toEqual({ level: 'high', budgetTokens: 63_999 });
    const cramped = planSlot(rt, 'high', needs, '主力', 1_000);
    expect(cramped.maxTokens).toBe(1_000);
    expect(cramped.thinking).toEqual({ level: 'off', note: '主力 的上下文剩余空间容不下最小推理预算，本轮未开启推理' });
    expect(cramped.notices).toEqual(['主力 的上下文剩余空间容不下最小推理预算，本轮未开启推理']);
    expect(cramped.notices[0]).not.toMatch(/\d/);
  });
});
