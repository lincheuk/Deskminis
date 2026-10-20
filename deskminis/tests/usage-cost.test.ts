/**
 * F02 验收 4 / 阻断 2：费用只在价格与计费规则确定时估算；未知价格标为未知，绝不按 0 当成真实费用；
 * 缓存与推理是总数的子集，不双计。价格只来自当前端点自己的目录记录，中转不借用别家的价格。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeUsage, estimateCost, usageKeyOf, type TokenUsage } from '../src/shared/usage';
import type { ModelPrice } from '../src/shared/model-metadata';
import { ModelCatalog } from '../src/minisd/providers/model-catalog';
import { resolveRuntimeModel } from '../src/minisd/providers/runtime-model';
import { finalizeUsage } from '../src/minisd/agent/request-budget';
import { EXAMPLE_APIS, PLAN_API, catalogFixtureF02, jsonResponse } from './runtime-model-fixture';

const PRICE: ModelPrice = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const usage = (u: Partial<TokenUsage>): TokenUsage => ({ inputTokens: 1_000, outputTokens: 200, ...u });
/** 期望值：各项 token × 每百万 token 的美元价之和（单位是百万分之一美元），四舍五入到 6 位小数。算式在每条用例里手写。 */
const usd = (micro: number): number => Math.round(micro) / 1_000_000;

describe('estimateCost', () => {
  it('C1 没有价格、分档计价、服务商没报完整用量：各得对应的 unknown，不给数字', () => {
    expect(estimateCost(usage({}), undefined)).toEqual({ status: 'unknown', reason: 'no-price' });
    expect(estimateCost(usage({}), { input: 5, output: 15, tiered: true })).toEqual({ status: 'unknown', reason: 'tiered' });
    expect(estimateCost(usage({ outputTokens: 0, unreported: ['output'] }), PRICE)).toEqual({ status: 'unknown', reason: 'unreported' });
  });

  it('C2 缓存读写先从总输入里减掉再各自计价，不双计', () => {
    const u = usage({ cacheReadTokens: 800, cacheWriteTokens: 100 });
    expect(estimateCost(u, PRICE)).toEqual({ status: 'estimated', usd: usd(100 * 3 + 800 * 0.3 + 100 * 3.75 + 200 * 15) });
    // 对照：不减缓存部分的算法会多出 900 × 3
    expect((estimateCost(u, PRICE) as { usd: number }).usd).toBeLessThan(usd(1_000 * 3 + 200 * 15));
  });

  it('C3 有缓存读写而目录没有对应的价：未知，不拿输入价顶替', () => {
    const flat: ModelPrice = { input: 3, output: 15 };
    expect(estimateCost(usage({ cacheReadTokens: 800 }), flat)).toEqual({ status: 'unknown', reason: 'cache-price' });
    expect(estimateCost(usage({ cacheWriteTokens: 100 }), { ...flat, cacheRead: 0.3 })).toEqual({ status: 'unknown', reason: 'cache-price' });
    // 服务商报的是 0：不需要缓存价
    expect(estimateCost(usage({ cacheReadTokens: 0, cacheWriteTokens: 0 }), flat)).toEqual({ status: 'estimated', usd: usd(1_000 * 3 + 200 * 15) });
  });

  it('C4 推理是输出的子集：有单独推理价时推理只按推理价计一次，没有时随输出计一次；另行标价而没报推理 token 时未知', () => {
    const apart: ModelPrice = { input: 0.3, output: 0.6, reasoning: 2.4 };
    expect(estimateCost(usage({ reasoningTokens: 150 }), apart)).toEqual({ status: 'estimated', usd: usd(1_000 * 0.3 + 50 * 0.6 + 150 * 2.4) });
    expect(estimateCost(usage({ reasoningTokens: 150 }), { input: 0.3, output: 0.6 })).toEqual({ status: 'estimated', usd: usd(1_000 * 0.3 + 200 * 0.6) });
    expect(estimateCost(usage({}), apart)).toEqual({ status: 'unknown', reason: 'reasoning-price' });
    // 推理价与输出价相同：没报推理 token 也能算
    expect(estimateCost(usage({}), { input: 0.3, output: 0.6, reasoning: 0.6 })).toEqual({ status: 'estimated', usd: usd(1_000 * 0.3 + 200 * 0.6) });
  });

  it('C5 输入输出标价都是 0：费用未知（目录里的 0 多是订阅计费的占位），不是 0 元；只有一侧为 0 时照常计算', () => {
    expect(estimateCost(usage({}), { input: 0, output: 0 })).toEqual({ status: 'unknown', reason: 'zero-price' });
    expect(estimateCost(usage({}), { input: 0, output: 0, cacheRead: 0 })).toEqual({ status: 'unknown', reason: 'zero-price' });
    expect(estimateCost(usage({}), { input: 0, output: 15 })).toEqual({ status: 'estimated', usd: usd(200 * 15) });
  });

  it('C8 用量极小、四舍五入后为 0：仍是 estimated（界面写「不足 $0.0001」），与 zero-price 的未知是两回事', () => {
    expect(estimateCost({ inputTokens: 3, outputTokens: 0 }, { input: 0.1, output: 0.4 })).toEqual({ status: 'estimated', usd: 0 });
    // 四舍五入到 6 位小数
    expect(estimateCost({ inputTokens: 321, outputTokens: 4 }, { input: 1.25, output: 10 })).toEqual({ status: 'estimated', usd: 0.000441 });
  });
});

describe('价格只来自当前端点自己的目录记录', () => {
  let dir: string;
  let catalog: ModelCatalog;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'dm-cost-'));
    catalog = new ModelCatalog(join(dir, 'catalog.json'), async () => jsonResponse(catalogFixtureF02()));
    await catalog.refresh(true);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('C6 服务商记录带 price，跨服务商汇总不带；从缓存文件重新加载后相同；只有 cost 的条目仍被丢弃', () => {
    const check = (c: ModelCatalog): void => {
      expect(c.getEndpointRecord('vendor-a', 'ind-model')?.price).toEqual({ input: 1.25, output: 10, cacheRead: 0.125 });
      expect(c.getEndpointRecord('vendor-a', 'wide-model')?.price).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
      expect(c.getEndpointRecord('vendor-a', 'tier-model')?.price).toEqual({ input: 5, output: 15, tiered: true });
      expect(c.getEndpointRecord('vendor-a', 'reason-model')?.price).toEqual({ input: 0.3, output: 0.6, reasoning: 2.4 });
      // 目录没写 cost 的型号不带 price 键
      expect('price' in c.getEndpointRecord('vendor-a', 'shared-model')!).toBe(false);
      // 汇总层只带列出的字段：价格不进跨服务商汇总
      const declared = c.getDeclaredRecord('ind-model');
      expect(declared?.tier).toBe('aggregate');
      expect(declared?.entry.price).toBeUndefined();
      expect('price' in declared!.entry).toBe(false);
      expect(c.getEndpointRecord('vendor-a', 'cost-only')).toBeUndefined();
      expect(c.getDeclaredRecord('cost-only')).toBeUndefined();
    };
    check(catalog);
    // 交出去的是深拷贝：改它不回写目录
    catalog.getEndpointRecord('vendor-a', 'ind-model')!.price!.input = 999;
    check(catalog);
    // 新实例只从缓存文件加载（不联网）
    check(new ModelCatalog(join(dir, 'catalog.json'), async () => { throw new Error('offline'); }));
  });

  it('C6b 收录端点取到自己的价格；同名型号经中转没有价格（不借用别家的）', () => {
    const own = resolveRuntimeModel({ kind: 'openai-compat', baseUrl: EXAMPLE_APIS.vendorA, modelId: 'ind-model' }, catalog);
    expect(own.price).toEqual({ input: 1.25, output: 10, cacheRead: 0.125 });
    const relayed = resolveRuntimeModel({ kind: 'openai-compat', baseUrl: 'https://relay.example/v1', modelId: 'ind-model' }, catalog);
    expect(relayed.catalog.record).toBe('aggregate');
    expect('price' in relayed).toBe(false);
    const u = usage({ cacheReadTokens: 800 });
    expect(estimateCost(u, own.price)).toEqual({ status: 'estimated', usd: usd(200 * 1.25 + 800 * 0.125 + 200 * 10) });
    expect(estimateCost(u, relayed.price)).toEqual({ status: 'unknown', reason: 'no-price' });
    // 分档计价的型号：有价格也不估
    const tiered = resolveRuntimeModel({ kind: 'openai-compat', baseUrl: EXAMPLE_APIS.vendorA, modelId: 'tier-model' }, catalog);
    expect(estimateCost(u, tiered.price)).toEqual({ status: 'unknown', reason: 'tiered' });
  });

  it('C6c 计费规则不确定的目录写法都不当成可按单一价格估算：context_over_200k 也标分档；input / output 缺一个或不是有限非负数就没有价格', async () => {
    const fixture = catalogFixtureF02() as Record<string, { models: Record<string, unknown> }>;
    const spec = { tool_call: true, modalities: { input: ['text'], output: ['text'] }, limit: { context: 1_000_000, output: 64_000 } };
    Object.assign(fixture['vendor-a'].models, {
      // 「超过 20 万上下文另行标价」的另一种写法：不是 tiers 数组，而是一个 context_over_200k 对象
      'over200k-model': { ...spec, cost: { input: 1.25, output: 10, context_over_200k: { input: 2.5, output: 15 } } },
      'input-only-model': { ...spec, cost: { input: 3 } },
      'output-only-model': { ...spec, cost: { output: 15 } },
      'negative-price-model': { ...spec, cost: { input: -1, output: 15 } },
      'string-price-model': { ...spec, cost: { input: '3', output: 15 } },
    });
    const noPrice = ['input-only-model', 'output-only-model', 'negative-price-model', 'string-price-model'];
    const odd = new ModelCatalog(join(dir, 'odd-catalog.json'), async () => jsonResponse(fixture));
    await odd.refresh(true);
    const check = (c: ModelCatalog): void => {
      expect(c.getEndpointRecord('vendor-a', 'over200k-model')?.price).toEqual({ input: 1.25, output: 10, tiered: true });
      for (const id of noPrice) {
        const record = c.getEndpointRecord('vendor-a', id);
        // 规格字段照常保留，只是不带价格：半截的价格算出来的是 NaN，界面会把它写成「不足 $0.0001」
        expect(record?.contextWindow, id).toBe(1_000_000);
        expect('price' in record!, id).toBe(false);
      }
    };
    check(odd);
    check(new ModelCatalog(join(dir, 'odd-catalog.json'), async () => { throw new Error('offline'); }));
    // 一路到落库的费用状态：都是未知，不出金额
    const costOf = (modelId: string) =>
      estimateCost(usage({}), resolveRuntimeModel({ kind: 'openai-compat', baseUrl: EXAMPLE_APIS.vendorA, modelId }, odd).price);
    expect(costOf('over200k-model')).toEqual({ status: 'unknown', reason: 'tiered' });
    for (const id of noPrice) expect(costOf(id), id).toEqual({ status: 'unknown', reason: 'no-price' });
  });

  it('C7 零标价的收录端点（订阅 / 套餐计费的形状）：取到的价格是 {0, 0}，费用判未知', () => {
    const rt = resolveRuntimeModel({ kind: 'openai-compat', baseUrl: PLAN_API, modelId: 'zero-price-model' }, catalog);
    expect(rt.endpoint).toMatchObject({ class: 'catalog', catalogProviderId: 'plan-vendor' });
    expect(rt.price).toEqual({ input: 0, output: 0 });
    expect(estimateCost(usage({}), rt.price)).toEqual({ status: 'unknown', reason: 'zero-price' });
    // 落库时盖的章同样是未知
    const stamped = finalizeUsage(usage({}), { by: 'provider', protocol: 'openai-chat', modelId: 'zero-price-model' }, { estimate: { text: 900, media: 0, input: 900 }, price: rt.price });
    expect(stamped?.cost).toEqual({ status: 'unknown', reason: 'zero-price' });
  });
});

describe('describeUsage：容错读取，旧记录兼容', () => {
  it('旧记录（没有 v）原样可读：标为旧口径，费用未知；旧版本的 0/0 当作没有用量，不当成真实的 0', () => {
    expect(describeUsage({ inputTokens: 10, outputTokens: 25 })).toEqual({ input: 10, output: 25, total: 35, unreported: [], legacy: true, cost: { status: 'unknown', reason: 'legacy' } });
    expect(describeUsage({ inputTokens: 0, outputTokens: 0 })).toEqual({ input: 0, output: 0, total: 0, unreported: ['input', 'output'], legacy: true, cost: { status: 'unknown', reason: 'no-usage' } });
    // 旧记录就算带着别的键也不估费用
    expect(describeUsage({ inputTokens: 10, outputTokens: 25, cost: { status: 'estimated', usd: 1 } })?.cost).toEqual({ status: 'unknown', reason: 'legacy' });
  });

  it('新记录：子维度是总数的子集，total 不把它们再加一遍；缺失的维度不带键；没有 cost 字段时费用未知', () => {
    const source = { by: 'provider' as const, protocol: 'anthropic' as const, modelId: 'claude-x', instanceId: 'i1' };
    const view = describeUsage({
      inputTokens: 4_096, outputTokens: 503, cacheReadTokens: 1_800, cacheWriteTokens: 248, reasoningTokens: 312, v: 2, source,
      estimate: { text: 3_900, media: 0, input: 3_900 }, cost: { status: 'estimated', usd: 0.012 },
    });
    expect(view).toEqual({
      input: 4_096, output: 503, total: 4_599, cacheRead: 1_800, cacheWrite: 248, reasoning: 312, unreported: [], legacy: false,
      source, estimate: { text: 3_900, media: 0, input: 3_900 }, cost: { status: 'estimated', usd: 0.012 },
    });
    expect(usageKeyOf(view!.source)).toBe('anthropic:claude-x');
    expect(usageKeyOf({ by: 'provider', modelId: 'claude-x' })).toBeUndefined();
    const bare = describeUsage({ inputTokens: 5, outputTokens: 0, unreported: ['output'], v: 2 })!;
    expect(bare).toEqual({ input: 5, output: 0, total: 5, unreported: ['output'], legacy: false, cost: { status: 'unknown', reason: 'no-price' } });
    expect('cacheRead' in bare || 'reasoning' in bare).toBe(false);
    // 新口径的 0/0 不当旧记录处理（循环不会落这种记录，但读取要讲得通）
    expect(describeUsage({ inputTokens: 0, outputTokens: 0, v: 2 })?.unreported).toEqual([]);
  });

  it('非法值：总数不合法返回 undefined；子维度非法或大于所属总数就丢掉；乱写的 cost / source 不采信', () => {
    for (const bad of [null, undefined, 'x', 3, [], { inputTokens: -1, outputTokens: 2 }, { inputTokens: '10', outputTokens: 2 }, { inputTokens: 1 }, { inputTokens: Number.NaN, outputTokens: 1 }]) {
      expect(describeUsage(bad), JSON.stringify(bad)).toBeUndefined();
    }
    const view = describeUsage({
      inputTokens: 100, outputTokens: 50, cacheReadTokens: 5_000, cacheWriteTokens: -1, reasoningTokens: 80, v: 2,
      unreported: ['bogus'], cost: { status: 'estimated', usd: -3 }, source: { by: 'app', modelId: 'm' }, estimate: { text: 'x' },
    });
    expect(view).toEqual({ input: 100, output: 50, total: 150, unreported: [], legacy: false, cost: { status: 'unknown', reason: 'no-price' } });
  });
});
