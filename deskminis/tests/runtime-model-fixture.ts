/** F01 测试共用的 models.dev 形状夹具（字段与 2026-10-02 公开快照同构，数值是编的）。
 *  - anthropic / google / openai 无 api 字段（官方端点靠内置主机表认）；
 *  - vendor-a / vendor-b 同一个 shared-model、不同的窗口、输出、推理与工具（同名不同服务商的主场景）；
 *  - tie-1 / tie-2 的 api 完全相同（分不清就按中转处理）；media-lab 是只出图 / 只出视频的专用模型。 */
export interface FixtureApis { vendorA: string; vendorB: string; tie: string; /** F01R：loop-lab 登记的回环 api（catalogFixtureF01R 才用）。 */ loopback?: string }

export const EXAMPLE_APIS: FixtureApis = {
  vendorA: 'https://api.vendor-a.example/v1',
  vendorB: 'https://api.vendor-b.example/openai/v1',
  tie: 'https://tie.example/v1',
};

export function catalogFixture(apis: FixtureApis = EXAMPLE_APIS): Record<string, unknown> {
  return {
    anthropic: { id: 'anthropic', name: 'Anthropic', models: {
      'claude-x': {
        name: 'Claude X', limit: { context: 1_000_000, output: 64_000 }, reasoning: true, tool_call: true,
        reasoning_options: [{ type: 'budget_tokens', min: 1024 }],
        modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
      },
      'claude-opus-5-5': {
        limit: { context: 1_000_000, output: 128_000 }, reasoning: true, tool_call: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] }],
        modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
      },
    } },
    google: { id: 'google', models: {
      'gem-v': {
        name: 'Gem V', limit: { context: 1_048_576, output: 65_536 }, reasoning: true, tool_call: true, structured_output: true,
        reasoning_options: [{ type: 'effort', values: ['minimal', 'low', 'medium', 'high'] }],
        modalities: { input: ['text', 'image', 'audio', 'video', 'pdf'], output: ['text'] },
      },
    } },
    openai: { id: 'openai', models: {
      'gpt-text': { limit: { context: 128_000, output: 16_384 }, reasoning: false, tool_call: true, modalities: { input: ['text', 'image'], output: ['text'] } },
    } },
    'vendor-a': { id: 'vendor-a', api: apis.vendorA, models: {
      'shared-model': {
        name: 'Shared Model', limit: { context: 200_000, output: 32_000 }, reasoning: true, tool_call: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }],
        modalities: { input: ['text', 'image'], output: ['text'] },
      },
      // 两家的模态列表只差一个 pdf：整组共识为空，逐项看图片却是一致的
      'vision-model': { limit: { context: 64_000 }, modalities: { input: ['text', 'image'], output: ['text'] } },
      'plain-model': { limit: { context: 64_000 }, modalities: { input: ['text'], output: ['text'] } },
    } },
    'vendor-b': { id: 'vendor-b', api: apis.vendorB, models: {
      'shared-model': {
        limit: { context: 128_000, output: 8_000 }, reasoning: false, tool_call: false,
        modalities: { input: ['text'], output: ['text'] },
      },
      'vision-model': { limit: { context: 64_000 }, modalities: { input: ['text', 'image', 'pdf'], output: ['text'] } },
      'plain-model': { limit: { context: 64_000 }, modalities: { input: ['text', 'pdf'], output: ['text'] } },
    } },
    'tie-1': { api: apis.tie, models: { 'tie-model': { limit: { context: 64_000, output: 4_000 }, tool_call: true } } },
    'tie-2': { api: apis.tie, models: { 'tie-model': { limit: { context: 32_000, output: 2_000 }, tool_call: true } } },
    'media-lab': { models: {
      painter: { limit: { output: 0 }, reasoning: false, tool_call: false, modalities: { input: ['text'], output: ['image'] } },
      'veo-x': { limit: { context: 480, output: 8192 }, reasoning: false, tool_call: false, modalities: { input: ['text'], output: ['video'] } },
      'bare-model': { limit: { context: 32_000 } },
    } },
  };
}

/** F01R 复核回归用的夹具 = catalogFixture 原样 + 下面这些型号（新 id、新服务商，原有 id 的汇总结果不变）：
 *  - ctx-out：vendor-a 的输出上限写成等于窗口（models.dev 对没有单独输出上限的型号的占位写法），另两家写 65536；
 *  - mute-model：三家都有记录、都说不支持工具、都不列图片（汇总否定达到 3 家）；
 *  - solo-neg：只有 vendor-c 一家的否定（不足 3 家）；
 *  - text-dispute：vendor-a 的记录不列文本输出、vendor-c 列了；a-painter：只有 vendor-a 一家且不列文本输出；
 *  - in-dispute：输入一侧的对称形状——vendor-a 的记录不列文本输入、vendor-c 列了（vendor-c 还写了 reasoning，
 *    vendor-a 的记录没写这一项）；in-solo：只有 vendor-a 一家且不列文本输入；
 *  - gem-third：只有 vendor-c 一家的记录、标注支持推理（官方端点自己的记录里没有这个型号）；
 *  - claude-third（只有第三方记录）、claude-nolimit（官方记录缺窗口）：官方 Anthropic 端点 200K 计法的两种来源；
 *  - loop-lab：登记了回环 api 的服务商（真实目录里 lmstudio 等就是这样）。 */
export function catalogFixtureF01R(apis: FixtureApis = EXAMPLE_APIS): Record<string, unknown> {
  const base = catalogFixture(apis) as Record<string, { models: Record<string, unknown> }>;
  const mute = { limit: { context: 64_000, output: 4_000 }, tool_call: false, modalities: { input: ['text'], output: ['text'] } };
  const ctxOut = (output: number) => ({ limit: { context: 262_144, output }, tool_call: true, modalities: { input: ['text', 'image'], output: ['text'] } });
  Object.assign(base['vendor-a'].models, {
    'ctx-out': ctxOut(262_144),
    'mute-model': mute,
    'text-dispute': { limit: { context: 64_000, output: 4_000 }, tool_call: true, modalities: { input: ['text'], output: ['image'] } },
    'a-painter': { limit: { context: 64_000, output: 4_000 }, modalities: { input: ['text'], output: ['image'] } },
    'in-dispute': { limit: { context: 64_000, output: 4_000 }, tool_call: true, modalities: { input: ['image'], output: ['text'] } },
    'in-solo': { limit: { context: 64_000, output: 4_000 }, modalities: { input: ['audio'], output: ['text'] } },
  });
  Object.assign(base['vendor-b'].models, { 'ctx-out': ctxOut(65_536), 'mute-model': mute });
  Object.assign(base.anthropic.models, {
    'claude-nolimit': { limit: { output: 64_000 }, reasoning: true, tool_call: true, modalities: { input: ['text', 'image'], output: ['text'] } },
  });
  return {
    ...base,
    'vendor-c': { id: 'vendor-c', models: {
      'ctx-out': ctxOut(65_536),
      'mute-model': mute,
      'text-dispute': { limit: { context: 64_000, output: 4_000 }, tool_call: true, modalities: { input: ['text'], output: ['text'] } },
      'solo-neg': { limit: { context: 64_000, output: 4_000 }, reasoning: false, tool_call: false, modalities: { input: ['text'], output: ['text'] } },
      'in-dispute': { limit: { context: 64_000, output: 4_000 }, reasoning: true, tool_call: true, modalities: { input: ['text', 'image'], output: ['text'] } },
      'gem-third': { limit: { context: 1_048_576, output: 65_536 }, reasoning: true, tool_call: true, modalities: { input: ['text', 'image'], output: ['text'] } },
      'claude-third': { limit: { context: 1_000_000 } },
      'claude-nolimit': { limit: { context: 1_000_000 } },
    } },
    'loop-lab': { id: 'loop-lab', api: apis.loopback ?? 'http://localhost:8080/v1', models: {
      'loop-only': { limit: { context: 8_000, output: 4_000 }, tool_call: false, modalities: { input: ['text'], output: ['text'] } },
    } },
  };
}

/** F02 夹具用的套餐端点地址（zero-price-model 挂在它下面）。 */
export const PLAN_API = 'https://api.plan-vendor.example/v1';

/** F02（请求预算、usage、费用）用的夹具 = catalogFixtureF01R 原样 + 下面这些型号（都是新 id，原有 id 的解析结果不变）。
 *  cost 的形状与 2026-10-02 公开快照同构（每百万 token 的美元价；tiers 是按上下文长度分档的数组）：
 *  - ind-model：目录另给输入上限，输入 + 输出 ≤ 窗口（400,000 = 272,000 + 128,000，官方 gpt-5 的形状），带缓存价；
 *  - both-model：有输入上限、但输入 + 输出 > 窗口（共享窗口上再叠一个输入上限）；
 *  - small-model：32,000 的小窗口；wide-model：窗口 400,000、输出 128,000、没有输入上限（与 ind-model 对照的共享窗口）；
 *  - tier-model：分档计价；reason-model：推理另行标价；
 *  - plan-vendor / zero-price-model：输入输出标价都是 0、带 api 地址的服务商——订阅或套餐计费的端点在目录里就是这样，0 只是占位。 */
export function catalogFixtureF02(apis: FixtureApis = EXAMPLE_APIS, planApi: string = PLAN_API): Record<string, unknown> {
  const base = catalogFixtureF01R(apis) as Record<string, { models: Record<string, unknown> }>;
  const text = { tool_call: true, modalities: { input: ['text', 'image'], output: ['text'] } };
  Object.assign(base['vendor-a'].models, {
    'ind-model': { ...text, limit: { context: 400_000, input: 272_000, output: 128_000 }, cost: { input: 1.25, output: 10, cache_read: 0.125 } },
    'both-model': { ...text, limit: { context: 200_000, input: 180_000, output: 64_000 }, cost: { input: 3, output: 15 } },
    'small-model': { ...text, limit: { context: 32_000, output: 8_000 }, cost: { input: 0.5, output: 1.5 } },
    'wide-model': { ...text, limit: { context: 400_000, output: 128_000 }, cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } },
    'tier-model': {
      ...text, limit: { context: 1_000_000, output: 64_000 },
      cost: { input: 5, output: 15, tiers: [{ input: 6.25, output: 18.5, tier: { type: 'context', size: 128_000 } }] },
    },
    'reason-model': { ...text, limit: { context: 128_000, output: 32_000 }, cost: { input: 0.3, output: 0.6, reasoning: 2.4 } },
    // 只有 cost、别的字段全空：不成其为一条记录，照旧丢弃
    'cost-only': { cost: { input: 1, output: 2 } },
  });
  return {
    ...base,
    'plan-vendor': { id: 'plan-vendor', api: planApi, models: {
      'zero-price-model': { ...text, limit: { context: 200_000, output: 32_000 }, cost: { input: 0, output: 0 } },
    } },
  };
}

export const jsonResponse = (data: unknown): Response => new Response(JSON.stringify(data), { status: 200 });
