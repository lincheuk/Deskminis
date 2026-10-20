/**
 * F02 渲染端：上下文条、上次请求的用量与费用、截断说明、预算错误条、设置页规格卡。
 * 文案层（lib/budget/format.ts）是纯函数，直接表驱动；store 与组件真跑（pinia + sfc-setup），rpc 用桩。
 * 费用这一块是任务卡的阻断项：价格未知、标价为 0、计费规则不确定时一律显示为未知，绝不显示成 0 元。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vue from 'vue';

const { rpcCall } = vi.hoisted(() => ({ rpcCall: vi.fn() }));
vi.mock('../src/renderer/src/rpc', () => ({
  rpc: { call: rpcCall, connect: async () => {}, on: () => {}, off: () => {}, onLost: () => {} },
}));

// eslint-disable-next-line import/first —— vi.mock 由 vitest 提升到顶部，此处 import 拿到的是桩
import { createPinia, setActivePinia } from 'pinia';
// eslint-disable-next-line import/first
import { useChat } from '../src/renderer/src/stores/chat';
// eslint-disable-next-line import/first
import { capabilityShortByCause, errorShortByCode, eventCopy, fallbackShortByCause } from '../src/renderer/src/lib/eventnote/copy';
// eslint-disable-next-line import/first
import {
  MISSING_USAGE_TEXT, barOf, breakdownOf, costText, estimateNoteOf, lastRequestOf, limitNoteOf, outputNoteOf, outputRequestNote,
  readOutputLimit, truncationText, usageLine,
} from '../src/renderer/src/lib/budget/format';
// eslint-disable-next-line import/first
import { ModelCatalog } from '../src/minisd/providers/model-catalog';
// eslint-disable-next-line import/first
import { limitProfile, resolveRuntimeModel, type RuntimeModelInput } from '../src/minisd/providers/runtime-model';
// eslint-disable-next-line import/first
import { runSetup } from './sfc-setup';
// eslint-disable-next-line import/first
import { sfcBlocks } from './sfc-blocks';
// eslint-disable-next-line import/first
import { EXAMPLE_APIS, catalogFixtureF02, jsonResponse } from './runtime-model-fixture';
// eslint-disable-next-line import/first
import { buildRequestBudget, type BudgetMeasure, type LimitProfile, type RequestBudget } from '../src/shared/request-budget';
// eslint-disable-next-line import/first
import { describeUsage, estimateCost, type CostEstimate, type CostUnknownReason, type TokenUsage } from '../src/shared/usage';
// eslint-disable-next-line import/first
import type { RuntimeModel } from '../src/shared/runtime-model';

const UI = join(__dirname, '../src/renderer/src/ui');
const SEC = join(UI, 'settings/SecModels.vue');
const TASK = join(UI, 'TaskPanel.vue');

let dir: string;
let catalog: ModelCatalog;
let scope = vue.effectScope();
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dm-renderer-budget-'));
  catalog = new ModelCatalog(join(dir, 'c.json'), async () => jsonResponse(catalogFixtureF02()));
  await catalog.refresh(true);
  setActivePinia(createPinia());
  scope = vue.effectScope();
  rpcCall.mockReset();
  rpcCall.mockImplementation(async (method: string, params: Record<string, unknown>) => {
    if (method === 'provider.runtime.resolve') return { runtime: resolveRuntimeModel(params as unknown as RuntimeModelInput, catalog), status: catalog.getStatus() };
    if (method === 'provider.catalog.get') return catalog.getStatus();
    if (method === 'provider.instances.list') return [];
    if (method === 'provider.getDefault') return { id: '' };
    if (method === 'chat.messages.list') return [];
    return { ok: true };
  });
});
afterEach(() => { scope.stop(); rmSync(dir, { recursive: true, force: true }); });

const shared = (window: number, cap: number, extra: Partial<LimitProfile> = {}): LimitProfile =>
  ({ kind: 'shared', inputLimit: window, sharedWindow: window, outputCap: cap, windowKnown: true, authority: 'endpoint', basis: 'window', note: '', ...extra });
const separate = (inputLimit: number, cap: number): LimitProfile =>
  ({ kind: 'separate', inputLimit, outputCap: cap, windowKnown: true, authority: 'endpoint', basis: 'catalog-input', note: '' });
function budgetOf(limits: LimitProfile, m: Partial<BudgetMeasure>, o: { preference?: number; source?: 'manual' | 'task' | 'default'; calibration?: RequestBudget['input']['calibration'] } = {}): RequestBudget {
  return buildRequestBudget({
    slot: { label: 'L', modelId: 'm', key: 'k' }, limits,
    measure: { system: 0, systemStable: m.system ?? 0, tools: 0, toolCount: 0, history: 0, reasoningReplay: 0, media: [], ...m },
    calibration: o.calibration ?? { ratio: 1, calibrated: false },
    preference: { tokens: o.preference ?? limits.outputCap, source: o.source ?? 'default' },
  });
}
const SOURCE = { by: 'provider' as const, protocol: 'openai-chat' as const, modelId: 'm' };
/** 没有金额的写法（零元、零点零零……）：费用行绝不能出现。「不足 $0.0001」不是零。 */
const ZERO_AMOUNT = /\$\s*0+(?:\.0+)?(?![.\d])/;

describe('文案层：上下文条与预算说明', () => {
  it('barOf：有预算时分母是输入上限、名称随约束形态；旧返回值退回窗口', () => {
    const sharedBudget = budgetOf(shared(200_000, 64_000), { system: 3_000, history: 17_000 });
    expect(barOf({ windowTokens: 200_000, usedTokens: sharedBudget.input.tokens, budget: sharedBudget })).toEqual({ used: 20_000, limit: 200_000, pct: 10, limitLabel: '上下文窗口' });
    const sep = budgetOf(separate(272_000, 128_000), { history: 136_000 });
    expect(barOf({ windowTokens: 400_000, usedTokens: sep.input.tokens, budget: sep })).toEqual({ used: 136_000, limit: 272_000, pct: 50, limitLabel: '输入上限' });
    expect(barOf({ windowTokens: 128_000, usedTokens: 32_000 })).toEqual({ used: 32_000, limit: 128_000, pct: 25, limitLabel: '上下文窗口' });
    expect(barOf({ windowTokens: 0, usedTokens: 5 }).pct).toBe(0);
    expect(barOf({ windowTokens: 1_000, usedTokens: 5_000 }).pct).toBe(100);
  });

  it('limitNoteOf：共享与独立两种约束；汇总来源、没有资料、实测推翻各追加一句', () => {
    expect(limitNoteOf(shared(200_000, 64_000))).toBe('输入与输出共用 200,000 的窗口');
    expect(limitNoteOf(separate(272_000, 128_000))).toBe('输入上限 272,000、输出上限 128,000，互不占用');
    expect(limitNoteOf(shared(180_000, 64_000, { sharedWindow: 200_000 }))).toBe('输入上限 180,000；输入与输出共用 200,000 的窗口');
    expect(limitNoteOf(shared(128_000, 8_000, { authority: 'advisory' }))).toBe('输入与输出共用 128,000 的窗口；上限不是当前端点自己的记录，只用于提前减压与收紧输出，不据此拒发');
    expect(limitNoteOf(shared(128_000, 8_192, { windowKnown: false, authority: 'none' }))).toBe('窗口没有资料，按 128,000 计，不据此限制输出');
    expect(limitNoteOf(shared(32_000, 8_192, { windowKnown: false, authority: 'manual', observedAbove: 44_000 })))
      .toBe('输入与输出共用 32,000 的窗口；实测输入 44,000 已达到这个上限，不再据此限制输出');
    // 真解析器给出的约束走一遍
    const rt = resolveRuntimeModel({ kind: 'openai-compat', baseUrl: EXAMPLE_APIS.vendorA, modelId: 'ind-model' }, catalog);
    expect(limitNoteOf(limitProfile(rt))).toBe('输入上限 272,000、输出上限 128,000，互不占用');
  });

  it('outputNoteOf：五种 limitedBy 各有原因', () => {
    const win = shared(200_000, 128_000);
    expect(outputNoteOf(budgetOf(win, { history: 1_000 }, { preference: 65_536 }).output)).toBe('本次 max_tokens 65,536（默认额度）');
    expect(outputNoteOf(budgetOf(win, { history: 1_000 }, { preference: 2_000, source: 'task' }).output)).toBe('本次 max_tokens 2,000（任务指定）');
    expect(outputNoteOf(budgetOf(shared(200_000, 100_000), { history: 1_000 }, { source: 'manual' }).output)).toBe('本次 max_tokens 100,000（手动填写的最大输出）');
    expect(outputNoteOf(budgetOf(shared(200_000, 8_000), { history: 1_000 }).output)).toBe('本次 max_tokens 8,000（模型输出上限）');
    expect(outputNoteOf(budgetOf(shared(32_000, 8_192), { history: 26_000 }).output)).toBe('本次 max_tokens 2,800（上下文剩余空间不足）');
    expect(outputNoteOf(budgetOf(shared(32_000, 8_192, { authority: 'advisory' }), { system: 50_000 }).output)).toBe('本次 max_tokens 1,024（已到下限）');
  });

  it('breakdownOf：五项分列，为 0 的行不出；图片写张数与三种估算方式', () => {
    const b = budgetOf(shared(200_000, 64_000), {
      system: 3_000, systemStable: 2_400, tools: 5_200, toolCount: 12, history: 800, reasoningReplay: 1_500,
      media: [{ kind: 'image', tokens: 1_296, basis: 'formula' }, { kind: 'image', tokens: 4_784, basis: 'upper-bound' }],
    });
    expect(breakdownOf(b).map(r => r.text)).toEqual([
      '系统提示（其中稳定段 2,400） 3,000', '工具（12 个） 5,200', '对话 800', '推理回放 1,500', '图片（2 张，按上限估算） 6,080',
    ]);
    const plain = budgetOf(shared(200_000, 64_000), { system: 3_000, history: 800 });
    expect(breakdownOf(plain).map(r => r.text)).toEqual(['系统提示 3,000', '对话 800']);
    const image = (basis: 'formula' | 'upper-bound' | 'default') => breakdownOf(budgetOf(shared(200_000, 64_000), { media: [{ kind: 'image', tokens: 258, basis }] }))[0].label;
    expect([image('formula'), image('upper-bound'), image('default')]).toEqual(['图片（1 张，按公式估算）', '图片（1 张，按上限估算）', '图片（1 张，保守估算）']);
  });

  it('estimateNoteOf：未校准照实写估算；已校准写上次偏差的方向', () => {
    const m = { history: 4_000 };
    expect(estimateNoteOf(budgetOf(shared(200_000, 64_000), m))).toBe('估算值，尚无实测校准');
    const cal = (errorPct: number) => budgetOf(shared(200_000, 64_000), m, { calibration: { ratio: 1.2, calibrated: true, last: { estimated: 1, actual: 1, errorPct } } });
    expect(estimateNoteOf(cal(29))).toBe('已按上次实测校准（上次估算比实测低 29%）');
    expect(estimateNoteOf(cal(-12))).toBe('已按上次实测校准（上次估算比实测高 12%）');
    expect(estimateNoteOf(cal(0))).toBe('已按上次实测校准（上次估算与实测一致）');
  });

  it('truncationText / readOutputLimit：写出那次的 max_tokens、原因、续写次数与出路', () => {
    expect(truncationText(null)).toBe('');
    expect(truncationText({ requested: 8_942, limitedBy: 'window', continued: 2 })).toBe('这次请求的 max_tokens 是 8,942（上下文剩余空间不足），已自动续写 2 次。上下文快满了，可新建会话或等下一轮压缩');
    expect(truncationText({ requested: 1_024, limitedBy: 'floor', continued: 0 })).toContain('上下文快满了');
    expect(truncationText({ requested: 65_536, limitedBy: 'preference', continued: 2 })).toBe('这次请求的 max_tokens 是 65,536（单次输出额度），已自动续写 2 次。需要更长的单次输出时，在「设置 → 模型 → 编辑 → 手动修正」填写最大输出');
    expect(truncationText({ requested: 8_192, limitedBy: 'model', continued: 2 })).toBe('这次请求的 max_tokens 是 8,192（模型输出上限），已自动续写 2 次。');
    expect(truncationText({ requested: 30_000, limitedBy: 'manual', continued: 1 })).toBe('这次请求的 max_tokens 是 30,000（手动填写的最大输出），已自动续写 1 次。');
    expect(readOutputLimit({ requested: 8_942, limitedBy: 'window', continued: 2 })).toEqual({ requested: 8_942, limitedBy: 'window', continued: 2 });
    for (const bad of [undefined, null, 'x', {}, { requested: '1', limitedBy: 'window' }, { requested: 1, limitedBy: 'bogus' }]) expect(readOutputLimit(bad)).toBeNull();
  });
});

describe('文案层：用量与费用（未知不当 0，不伪造精确费用）', () => {
  const REASONS: CostUnknownReason[] = ['no-usage', 'no-price', 'zero-price', 'tiered', 'legacy', 'unreported', 'cache-price', 'reasoning-price'];

  it('costText：八种未知原因都以「费用未知」开头，整句不含 $ 与任何阿拉伯数字', () => {
    const texts = REASONS.map(reason => costText({ status: 'unknown', reason }));
    for (const t of texts) {
      expect(t.startsWith('费用未知（')).toBe(true);
      expect(t).not.toContain('$');
      expect(t).not.toMatch(/\d/);
    }
    expect(new Set(texts).size).toBe(REASONS.length);
    expect(costText({ status: 'unknown', reason: 'zero-price' })).toBe('费用未知（目录标价为零，可能是免费额度或订阅计费，不能按 token 估算）');
    expect(costText({ status: 'unknown', reason: 'no-usage' })).toBe('费用未知（没有用量）');
  });

  it('costText：估算值写「约 $x（按目录价格估算）」；任何输入都不会写出零元', () => {
    expect(costText({ status: 'estimated', usd: 0.00335 })).toMatch(/^约 \$0\.003[34]（按目录价格估算）$/);
    expect(costText({ status: 'estimated', usd: 1.5 })).toBe('约 $1.5000（按目录价格估算）');
    const all: CostEstimate[] = [
      ...REASONS.map(reason => ({ status: 'unknown' as const, reason })),
      ...[0, 0.000001, 0.00004, 0.00005, 0.00009999, 0.0001, 0.00335, 0.5, 12].map(usd => ({ status: 'estimated' as const, usd })),
      { status: 'estimated', usd: Number.NaN },
    ];
    for (const c of all) expect(costText(c), JSON.stringify(c)).not.toMatch(ZERO_AMOUNT);
    for (const usd of [0, 0.000001, 0.00004, 0.00009999, Number.NaN]) expect(costText({ status: 'estimated', usd })).toBe('不足 $0.0001（按目录价格估算）');
    expect(costText({ status: 'estimated', usd: 0.0001 })).toBe('约 $0.0001（按目录价格估算）');
  });

  it('从价格到界面的整条链：零标价、没有价格、分档计价都显示未知，不出现金额', () => {
    // 输入 1.25、输出 10（每百万 token）：1000 × 1.25 + 304 × 10 = 4290 → $0.00429
    const u: TokenUsage = { inputTokens: 1_000, outputTokens: 304, v: 2, source: SOURCE };
    const zero = resolveRuntimeModel({ kind: 'openai-compat', baseUrl: 'https://api.plan-vendor.example/v1', modelId: 'zero-price-model' }, catalog);
    const relayed = resolveRuntimeModel({ kind: 'openai-compat', baseUrl: 'https://relay.example/v1', modelId: 'ind-model' }, catalog);
    const tiered = resolveRuntimeModel({ kind: 'openai-compat', baseUrl: EXAMPLE_APIS.vendorA, modelId: 'tier-model' }, catalog);
    const shown = (rt: RuntimeModel): string => costText(describeUsage({ ...u, cost: estimateCost(u, rt.price) })!.cost);
    expect(shown(zero)).toBe('费用未知（目录标价为零，可能是免费额度或订阅计费，不能按 token 估算）');
    expect(shown(relayed)).toBe('费用未知（当前端点没有可确认的价格资料）');
    expect(shown(tiered)).toBe('费用未知（该型号按上下文长度分档计价）');
    for (const rt of [zero, relayed, tiered]) { expect(shown(rt)).not.toContain('$'); expect(shown(rt)).not.toMatch(/\d/); }
    const priced = resolveRuntimeModel({ kind: 'openai-compat', baseUrl: EXAMPLE_APIS.vendorA, modelId: 'ind-model' }, catalog);
    expect(shown(priced)).toBe('约 $0.0043（按目录价格估算）');
  });

  it('usageLine：子维度写在所属总数的括号里；没报的总数写「服务商未报告」；旧记录带说明', () => {
    const view = (raw: Record<string, unknown>) => describeUsage(raw)!;
    expect(usageLine(view({ inputTokens: 4_096, outputTokens: 503, cacheReadTokens: 1_800, cacheWriteTokens: 248, reasoningTokens: 312, v: 2 })))
      .toBe('输入 4,096（缓存读取 1,800，缓存写入 248） · 输出 503（推理 312）');
    expect(usageLine(view({ inputTokens: 1_000, outputTokens: 50, cacheReadTokens: 0, v: 2 }))).toBe('输入 1,000（缓存读取 0） · 输出 50');
    expect(usageLine(view({ inputTokens: 25, outputTokens: 15, v: 2 }))).toBe('输入 25 · 输出 15');
    expect(usageLine(view({ inputTokens: 5, outputTokens: 0, unreported: ['output'], v: 2 }))).toBe('输入 5 · 输出 服务商未报告');
    expect(usageLine(view({ inputTokens: 0, outputTokens: 9, unreported: ['input'], v: 2 }))).toBe('输入 服务商未报告 · 输出 9');
    expect(usageLine(view({ inputTokens: 10, outputTokens: 25 }))).toBe('输入 10 · 输出 25；旧版本记录，输入可能不含缓存、输出可能不含推理');
    expect(usageLine(view({ inputTokens: 0, outputTokens: 0 }))).toBe(MISSING_USAGE_TEXT);
  });

  it('lastRequestOf：看最后一条 assistant 消息，不回溯；旧版本的 0/0 当作没有用量', () => {
    const full: TokenUsage = { inputTokens: 4_096, outputTokens: 503, cacheReadTokens: 1_800, reasoningTokens: 312, v: 2, source: SOURCE, cost: { status: 'estimated', usd: 0.0123 } };
    const user = { role: 'user' };
    expect(lastRequestOf([])).toEqual({ state: 'none' });
    expect(lastRequestOf([user])).toEqual({ state: 'none' });
    // 最后一条 assistant 没有 tokenUsage、更早一条有：不拿更早的数字顶替
    expect(lastRequestOf([user, { role: 'assistant', tokenUsage: full }, user, { role: 'assistant' }, user])).toEqual({ state: 'missing' });
    expect(lastRequestOf([{ role: 'assistant', tokenUsage: 'garbage' }])).toEqual({ state: 'missing' });
    // 最后一条是旧版本的 0/0：两行都不出现数字 0 与 $
    const legacyZero = lastRequestOf([{ role: 'assistant', tokenUsage: full }, { role: 'assistant', tokenUsage: { inputTokens: 0, outputTokens: 0 } }]);
    expect(legacyZero.state).toBe('usage');
    if (legacyZero.state !== 'usage') throw new Error('unreachable');
    expect(usageLine(legacyZero.view)).toBe(MISSING_USAGE_TEXT);
    expect(costText(legacyZero.view.cost)).toBe('费用未知（没有用量）');
    for (const line of [usageLine(legacyZero.view), costText(legacyZero.view.cost)]) { expect(line).not.toContain('0'); expect(line).not.toContain('$'); }
    // 完整用量
    const last = lastRequestOf([user, { role: 'assistant', tokenUsage: full }]);
    if (last.state !== 'usage') throw new Error('unreachable');
    expect(usageLine(last.view)).toBe('输入 4,096（缓存读取 1,800） · 输出 503（推理 312）');
    expect(costText(last.view.cost)).toBe('约 $0.0123（按目录价格估算）');
  });
});

describe('聊天 store：预算错误、截断说明、输出截断提示', () => {
  it('requestBudget 错误：不给重试、不给接力，短句说的是固定开销；按固定开销换模型的降级有专门短句', () => {
    const chat = useChat();
    chat.activeId = 'S1';
    chat.onEvent({ kind: 'error', code: 'requestBudget', message: '主力 放不下这次请求的固定部分（系统提示约 50000…）。本轮没有发送给任何模型', budget: { status: 'blocked' } });
    const note = chat.eventNotes.at(-1) as Record<string, unknown>;
    expect(note).toMatchObject({ kind: 'error', retryable: false, short: '请求放不下：系统提示与工具定义占满了模型的输入上限' });
    expect(note.relay).toBeUndefined();
    expect(chat.relaySource).toBeNull();
    expect(note.detail).toContain('本轮没有发送给任何模型');
    chat.onEvent({ kind: 'fallback', from: '小', to: '大', reason: '小 放不下这次请求的固定部分', cause: 'requestBudget' });
    expect(chat.eventNotes.at(-1)).toMatchObject({ kind: 'fallback', short: '当前模型放不下这次请求的固定部分，本轮改用 大' });
    expect(errorShortByCode('requestBudget')).toBe('请求放不下：系统提示与工具定义占满了模型的输入上限');
    expect(errorShortByCode('requestBudget')).not.toContain('未发送');
    expect(fallbackShortByCause('requestBudget', '大')).toBe('当前模型放不下这次请求的固定部分，本轮改用 大');
  });

  it('outputLimit 错误（输出额度在正文之前就用完）：短句按 code 给，说的是截断不是空响应；留着重试钮，不给接力', () => {
    const chat = useChat();
    chat.activeId = 'S1';
    // 详情里的 max_tokens 恰好是 5xx 样子的三位数：短句不能被说成「模型服务暂时不可用」
    const message = '主力 这次输出被 max_tokens 截断，没有产出正文：输出额度（max_tokens 512）在正文之前就用完了，多为推理占用。上下文剩余空间不足，这次的 max_tokens 是收紧过的；可新建会话，或调低推理档位后重发';
    chat.onEvent({ kind: 'error', code: 'outputLimit', message, outputLimit: { requested: 512, limitedBy: 'floor', continued: 0 } });
    const note = chat.eventNotes.at(-1) as Record<string, unknown>;
    expect(note).toMatchObject({ kind: 'error', retryable: true, short: '输出被 max_tokens 截断，没有产出正文', detail: message });
    expect(note.relay).toBeUndefined();
    expect(chat.relaySource).toBeNull();
    expect(chat.running).toBe(false);
    expect(errorShortByCode('outputLimit')).toBe('输出被 max_tokens 截断，没有产出正文');
    expect(errorShortByCode('outputLimit')).not.toContain('空响应');
    // 对照：不带 code 的同一句话交给 humanizeError，会被那个三位数带偏
    expect(eventCopy('error', message).short).toBe('模型服务暂时不可用（512）');
  });

  it('fallback 带 cause:outputLimit（输出额度在正文之前用完、组内换到备用）：短句说明为什么换、换给了谁，详情保留原说明；回合照常进行', () => {
    const chat = useChat();
    chat.activeId = 'S1';
    chat.running = true;
    const reason = '主力 这次输出被 max_tokens 截断，没有产出正文：输出额度（max_tokens 512）在正文之前就用完了，多为推理占用。这已是该模型的输出上限，可换用输出上限更大的模型';
    chat.onEvent({ kind: 'thinkingDelta', text: 'thinking it through ' });
    chat.onEvent({ kind: 'fallback', from: '主力', to: '备用', reason, cause: 'outputLimit' });
    const note = chat.eventNotes.at(-1) as Record<string, unknown>;
    expect(note).toMatchObject({ kind: 'fallback', short: '当前模型的输出被截断、没有产出正文，本轮改用 备用', detail: `主力 → 备用（${reason}）` });
    // 不是错误：不结束回合、不写错误横幅、不给重试钮；主力那段半截思考清掉（备用会重新推理）
    expect(chat.running).toBe(true);
    expect(chat.lastError).toBe('');
    expect('retryable' in note).toBe(false);
    expect(chat.streamingThinking).toBe('');
    // 任务面板的「模型降级」卡拿到同一句说明
    expect(chat.fallbackState).toEqual({ from: '主力', to: '备用', reason });
    expect(fallbackShortByCause('outputLimit', '备用')).toBe('当前模型的输出被截断、没有产出正文，本轮改用 备用');
    // 短句不把它说成空响应或故障；通用短句与其它 cause 的短句不变
    expect(fallbackShortByCause('outputLimit', '备用')).not.toMatch(/空响应|不可用|故障/);
    expect(fallbackShortByCause('requestBudget', '备用')).toBe('当前模型放不下这次请求的固定部分，本轮改用 备用');
    expect(fallbackShortByCause(undefined, '备用')).toBeUndefined();
    expect(eventCopy('fallback').short).toBe('已切换到备选模型');
  });

  it('capability 事件带 cause:outputLimit 时提示条有专门短句；不带 cause 时没有 short 键（通用短句）', () => {
    const chat = useChat();
    chat.activeId = 'S1';
    chat.onEvent({ kind: 'capability', label: '主力', notices: ['主力 这次输出被 max_tokens 截断：上下文剩余空间不足…'], cause: 'outputLimit' });
    expect(chat.eventNotes.at(-1)).toMatchObject({ kind: 'capability', short: '输出被 max_tokens 截断，原因见详情' });
    chat.onEvent({ kind: 'capability', label: '乙', notices: ['乙 不支持工具调用：本轮不提供工具'] });
    expect('short' in (chat.eventNotes.at(-1) as object)).toBe(false);
    expect(capabilityShortByCause('outputLimit')).toBe('输出被 max_tokens 截断，原因见详情');
    expect(capabilityShortByCause(undefined)).toBeUndefined();
    expect(capabilityShortByCause('other')).toBeUndefined();
    // 通用短句不变
    expect(eventCopy('capability').short).toBe('模型能力未确认或不符，处理方式见详情');
  });

  it('turnEnd.outputLimit 写入 lastOutputLimit；正常收尾清掉；换会话清零', async () => {
    const chat = useChat();
    chat.activeId = 'S1';
    chat.onEvent({ kind: 'turnEnd', stopReason: 'maxTokens', outputLimit: { requested: 8_942, limitedBy: 'window', continued: 2 } });
    expect(chat.lastStopReason).toBe('maxTokens');
    expect(chat.lastOutputLimit).toEqual({ requested: 8_942, limitedBy: 'window', continued: 2 });
    chat.onEvent({ kind: 'turnEnd', stopReason: 'endTurn' });
    expect(chat.lastOutputLimit).toBeNull();
    chat.onEvent({ kind: 'turnEnd', stopReason: 'maxTokens', outputLimit: { requested: 100, limitedBy: 'floor', continued: 1 } });
    expect(chat.lastOutputLimit).not.toBeNull();
    await chat.open('S2');
    expect(chat.lastOutputLimit).toBeNull();
    expect(chat.lastStopReason).toBe('');
  });
});

type TaskBindings = {
  bar: { value: { used: number; limit: number; pct: number; limitLabel: string } | null };
  pct: { value: number };
  budget: { value: RequestBudget | null };
  breakdown: { value: { text: string }[] };
  budgetWarning: { value: string };
  lastRequest: { value: { state: string } };
  truncation: { value: string };
};

describe('TaskPanel：真跑 setup', () => {
  it('旧返回值（没有 budget）不报错：条按窗口显示，分项与提示为空', async () => {
    const chat = useChat();
    chat.contextInfo = { windowTokens: 128_000, usedTokens: 32_000, remaining: 96_000 };
    const { bindings } = await runSetup<TaskBindings>(TASK, {}, scope);
    expect(bindings.bar.value).toEqual({ used: 32_000, limit: 128_000, pct: 25, limitLabel: '上下文窗口' });
    expect(bindings.budget.value).toBeNull();
    expect(bindings.breakdown.value).toEqual([]);
    expect(bindings.budgetWarning.value).toBe('');
    expect(bindings.lastRequest.value).toEqual({ state: 'none' });
    expect(bindings.truncation.value).toBe('');
    chat.contextInfo = null;
    await vue.nextTick();
    expect(bindings.bar.value).toBeNull();
    expect(bindings.pct.value).toBe(0);
  });

  it('带预算：条按输入上限；tight 时带引擎给的原因；截断说明只在 maxTokens 收尾时出', async () => {
    const chat = useChat();
    const b = budgetOf(shared(32_000, 8_192), { system: 2_000, history: 24_000 });
    chat.contextInfo = { windowTokens: 32_000, usedTokens: b.input.tokens, remaining: 6_000, budget: b, live: true };
    chat.messages = [{ id: 'm1', role: 'assistant', parts: [], tokenUsage: { inputTokens: 5, outputTokens: 0, unreported: ['output'], v: 2 } }];
    chat.lastStopReason = 'maxTokens';
    chat.lastOutputLimit = { requested: 2_800, limitedBy: 'window', continued: 2 };
    const { bindings } = await runSetup<TaskBindings>(TASK, {}, scope);
    expect(bindings.bar.value).toMatchObject({ used: 26_000, limit: 32_000, pct: 81, limitLabel: '上下文窗口' });
    expect(bindings.budgetWarning.value).toBe('输出空间只剩约 2800，低于预留值 8000：本次 max_tokens 收紧到 2800');
    expect(bindings.breakdown.value.map(r => r.text)).toEqual(['系统提示 2,000', '对话 24,000']);
    expect(bindings.lastRequest.value.state).toBe('usage');
    expect(bindings.truncation.value).toContain('max_tokens 是 2,800（上下文剩余空间不足），已自动续写 2 次');
    chat.lastStopReason = 'endTurn';
    await vue.nextTick();
    expect(bindings.truncation.value).toBe('');
  });

  it('源码守卫：模板用到了上下文条、分项、上次请求、费用、截断说明', () => {
    const { template } = sfcBlocks(readFileSync(TASK, 'utf8').replace(/\r\n/g, '\n'), 'TaskPanel.vue');
    for (const used of ['bar.limitLabel', 'breakdown', 'limitNoteOf(budget.limits)', 'outputNoteOf(budget.output)', 'estimateNoteOf(budget)', 'usageLine(lastRequest.view)', 'costText(lastRequest.view.cost)', 'MISSING_USAGE_TEXT', 'truncation']) {
      expect(template, used).toContain(used);
    }
    const { script } = sfcBlocks(readFileSync(TASK, 'utf8').replace(/\r\n/g, '\n'), 'TaskPanel.vue');
    for (const fn of ['barOf(', 'breakdownOf(', 'lastRequestOf(chat.messages)', 'truncationText(chat.lastOutputLimit)']) expect(script, fn).toContain(fn);
  });

  it('源码守卫：「上次请求」的三种状态——没有 assistant 消息才整块不出；有用量走 usageLine 与 costText；没有用量照样显示，写明没有用量、费用未知', () => {
    const { template } = sfcBlocks(readFileSync(TASK, 'utf8').replace(/\r\n/g, '\n'), 'TaskPanel.vue');
    const block = /<section v-if="([^"]+)"[^>]*data-budget="last-request">([\s\S]*?)<\/section>/.exec(template);
    expect(block).not.toBeNull();
    // 整块只在会话里还没有 assistant 消息时不出：最后一条没有可读的用量（missing）同样要显示，不能悄悄藏起来
    expect(block![1]).toBe("lastRequest.state !== 'none'");
    const body = block![2].replace(/\s+/g, ' ');
    expect(body).toContain(`<span v-if="lastRequest.state === 'usage'"`);
    expect(body).toContain('{{ usageLine(lastRequest.view) }}<br />{{ costText(lastRequest.view.cost) }}');
    // 另一支：固定的「没有用量数据」与「费用未知（没有用量）」
    expect(body).toMatch(/<span v-else[^>]*> \{\{ MISSING_USAGE_TEXT \}\}<br \/>\{\{ costText\(\{ status: 'unknown', reason: 'no-usage' \}\) \}\} <\/span>/);
    // 金额只能经 costText 出来：这一块的模板不直接写货币符号，也不直接读金额字段
    expect(body).not.toContain('$');
    expect(body).not.toContain('.usd');
  });

  it('源码守卫：面板里每个图标名都在图标表里（表里没有的名字会悄悄回退成「···」）', () => {
    const { template } = sfcBlocks(readFileSync(TASK, 'utf8').replace(/\r\n/g, '\n'), 'TaskPanel.vue');
    const icons = readFileSync(join(UI, 'UiIcon.vue'), 'utf8').replace(/\r\n/g, '\n');
    // 图标表 P 的键：一行一个「名字: '路径'」
    const table = /const P: Record<string, string> = \{([\s\S]*?)\n\};/.exec(icons)?.[1] ?? '';
    const known = new Set([...table.matchAll(/^\s*([A-Za-z]\w*): '/gm)].map(m => m[1]));
    expect(known.has('dots')).toBe(true);
    expect(known.has('clock')).toBe(true);
    expect(known.has('info')).toBe(false);
    // 回退表达式还在：名字不在表里就是 dots
    expect(icons).toContain('P[props.name] ?? P.dots');
    const used = [...template.matchAll(/<UiIcon\b[^>]*?\sname="([^"]+)"/g)].map(m => m[1]);
    expect(used.length).toBeGreaterThanOrEqual(6);
    for (const name of used) expect(known.has(name), name).toBe(true);
    // 动态绑定的名字这条守卫看不到：面板里不该有
    expect(template).not.toMatch(/<UiIcon\b[^>]*?\s:name=/);
    // 「上次请求」那张卡用的是时钟
    expect(template).toMatch(/data-budget="last-request"[\s\S]*?<UiIcon name="clock"/);
  });
});

type SecBindings = {
  runtime: { value: RuntimeModel | null };
  outputPlaceholder: { value: string };
  startEdit(p: Record<string, unknown>): void;
};

describe('设置页规格卡：单次请求实际申请多少', () => {
  const resolved = async (bindings: SecBindings, modelId: string): Promise<RuntimeModel> => {
    await vi.waitFor(() => { expect(bindings.runtime.value?.modelId).toBe(modelId); }, { timeout: 5000, interval: 20 });
    await vue.nextTick();
    return bindings.runtime.value!;
  };

  it('outputRequestNote 三个分支：手动最大输出、上限大于默认额度、上限不大于默认额度', () => {
    const rt = (input: RuntimeModelInput) => resolveRuntimeModel(input, catalog);
    expect(outputRequestNote(rt({ kind: 'openai-compat', baseUrl: EXAMPLE_APIS.vendorA, modelId: 'ind-model', maxOutputTokens: 100_000 })))
      .toBe('单次请求按手动填写的最大输出 100,000 申请；上下文剩余空间不足时收紧');
    expect(outputRequestNote(rt({ kind: 'openai-compat', baseUrl: EXAMPLE_APIS.vendorA, modelId: 'ind-model' })))
      .toBe('单次请求默认申请 65,536（上限 128,000），带推理预算时另加预算；上下文剩余空间不足时收紧。需要更长的单次输出可手动填写最大输出');
    expect(outputRequestNote(rt({ kind: 'openai-compat', baseUrl: 'https://relay.example/v1', modelId: 'unlisted-model' })))
      .toBe('单次请求按上限 8,192 申请；上下文剩余空间不足时收紧');
  });

  it('占位：上限 128,000 时说明默认按 65,536 申请；上限 32,000 时仍是「按资料」', async () => {
    const { bindings, mount } = await runSetup<SecBindings>(SEC, {}, scope);
    mount();
    bindings.startEdit({ id: 'P1', name: '甲', kind: 'openai-compat', baseUrl: EXAMPLE_APIS.vendorA, modelId: 'ind-model' });
    expect((await resolved(bindings, 'ind-model')).requestMaxTokens).toBe(128_000);
    expect(bindings.outputPlaceholder.value).toBe('留空 = 默认按 65,536 申请（资料上限 128,000）');
    bindings.startEdit({ id: 'P2', name: '甲', kind: 'openai-compat', baseUrl: EXAMPLE_APIS.vendorA, modelId: 'shared-model' });
    expect((await resolved(bindings, 'shared-model')).requestMaxTokens).toBe(32_000);
    expect(bindings.outputPlaceholder.value).toBe('留空 = 按资料（32,000）');
  });

  it('源码守卫：规格卡模板里有 outputRequestNote 一行；「最大输出」那一行不变', () => {
    const { template } = sfcBlocks(readFileSync(SEC, 'utf8').replace(/\r\n/g, '\n'), 'SecModels.vue');
    expect(template).toContain('{{ outputRequestNote(runtime) }}');
    expect(template).toMatch(/limitText\(runtime\.limits\.maxOutputTokens, `按 \$\{formatCount\(runtime\.requestMaxTokens\)\} 计`\)/);
  });
});
