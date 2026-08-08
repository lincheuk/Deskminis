import { describe, it, expect, beforeEach } from 'vitest';
import { ModelCatalog, resolveModelsDevConflict, MERGE_RULE_VERSION } from '../src/minisd/providers/model-catalog';
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

describe('BUILTIN 国内中转站模型族', () => {
  it('glm 族：contextWindow=128K，thinking=true', async () => {
    const c = new ModelCatalog(cacheFile, async () => { throw new Error('offline'); });
    expect(c.getModelContextWindow('glm-4.5')).toBe(128_000);
    expect(c.getModelContextWindow('glm-5.1')).toBe(128_000);
    expect(c.clampThinkingLevel('glm-4.5', 'high')).toBe('high');
  });

  it('grok 族：contextWindow=128K，thinking=true', async () => {
    const c = new ModelCatalog(cacheFile, async () => { throw new Error('offline'); });
    expect(c.getModelContextWindow('grok-4.5')).toBe(128_000);
    expect(c.clampThinkingLevel('grok-4.5', 'high')).toBe('high');
  });

  it('kimi 族：contextWindow=128K，thinking=true', async () => {
    const c = new ModelCatalog(cacheFile, async () => { throw new Error('offline'); });
    expect(c.getModelContextWindow('kimi-k2')).toBe(128_000);
    expect(c.clampThinkingLevel('kimi-k2', 'high')).toBe('high');
  });

  it('minimax 族：contextWindow=128K，thinking=true（当代主力 M2/M2.5/M3 全线支持推理）', async () => {
    const c = new ModelCatalog(cacheFile, async () => { throw new Error('offline'); });
    expect(c.getModelContextWindow('MiniMax-M2')).toBe(128_000);
    expect(c.clampThinkingLevel('MiniMax-M2', 'high')).toBe('high');
  });

  it('qwen（非 qwen3）族：contextWindow=128K，thinking=false', async () => {
    const c = new ModelCatalog(cacheFile, async () => { throw new Error('offline'); });
    expect(c.getModelContextWindow('qwen-max')).toBe(128_000);
    expect(c.clampThinkingLevel('qwen-max', 'high')).toBe('off');
  });

  it('qwen3 仍优先匹配 thinking=true（先中先赢顺序验证）', async () => {
    const c = new ModelCatalog(cacheFile, async () => { throw new Error('offline'); });
    expect(c.getModelContextWindow('qwen3-235b')).toBe(128_000);
    expect(c.clampThinkingLevel('qwen3-235b', 'high')).toBe('high'); // qwen3 条目优先
  });
});

describe('getModelContextWindow 优先级链 (M4.5 Task 3)', () => {
  it('优先级：手动值 > models.dev 缓存 > BUILTIN', async () => {
    const c = new ModelCatalog(cacheFile, fakeFetch()); // fakeFetch 含 gpt-4o: 128K
    await c.refresh(true);
    // models.dev 缓存命中
    expect(c.getModelContextWindow('gpt-4o')).toBe(128_000);
    // 手动值覆盖（通过 setManualOverride 注入）
    c.setManualOverride('gpt-4o', 256_000);
    expect(c.getModelContextWindow('gpt-4o')).toBe(256_000);
    // 手动值清空 → 回落缓存
    c.setManualOverride('gpt-4o', undefined);
    expect(c.getModelContextWindow('gpt-4o')).toBe(128_000);
  });

  it('手动值对 BUILTIN 族的覆盖', async () => {
    const c = new ModelCatalog(cacheFile, async () => { throw new Error('offline'); });
    expect(c.getModelContextWindow('glm-4.5')).toBe(128_000); // BUILTIN
    c.setManualOverride('glm-4.5', 200_000);
    expect(c.getModelContextWindow('glm-4.5')).toBe(200_000); // 手动优先
    c.setManualOverride('glm-4.5', undefined);
    expect(c.getModelContextWindow('glm-4.5')).toBe(128_000); // 回落 BUILTIN
  });

  it('手动值只影响 getModelContextWindow，不影响 clampThinkingLevel（决策点 3）', async () => {
    const c = new ModelCatalog(cacheFile, async () => { throw new Error('offline'); });
    // gpt-4o 在 BUILTIN 是 thinking:false → clamp 到 off
    // 即便手动覆盖窗口，clamp 仍走 lookup（BUILTIN thinking:false）
    c.setManualOverride('gpt-4o', 256_000);
    expect(c.getModelContextWindow('gpt-4o')).toBe(256_000); // 手动值生效
    expect(c.clampThinkingLevel('gpt-4o', 'high')).toBe('off'); // 仍钳 off（BUILTIN thinking:false）
  });

  it('手动值对完全未知模型的覆盖（BUILTIN 无该族）', async () => {
    const c = new ModelCatalog(cacheFile, async () => { throw new Error('offline'); });
    expect(c.getModelContextWindow('mystery-1')).toBeUndefined(); // 未知
    c.setManualOverride('mystery-1', 64_000);
    expect(c.getModelContextWindow('mystery-1')).toBe(64_000); // 手动值生效
    // clampThinkingLevel 仍钳 off（lookup 返回 undefined → !info 钳 off）
    expect(c.clampThinkingLevel('mystery-1', 'high')).toBe('off');
  });
});

/**
 * models.dev 主源多 vendor 同名冲突消解。
 *
 * 背景（复核方 2026-08-03 对 models.dev 全量 6043 条实测）：929 个 id 跨 provider 重复，
 * 其中 434 个各家报的 contextWindow 不一致（分歧最大 15.6 倍），189 个 reasoning 标记不一致。
 * 原实现 `models[id] = ...` 是后写覆盖（last-wins），值由 JSON 迭代顺序决定：
 *   - glm-5.1 实测取到 cortecs 的 204800，而官方 zhipuai/zai 报 200000 —— 高估
 *   - 63 个模型因末位 vendor 报 reasoning:false 而丢掉推理能力（如 glm-5 是 16:1 的少数派）
 * 且顺序依赖意味着 models.dev 重排 vendor 时值会静默改变。
 *
 * 规则按字段分开定，依据是「错的方向」而非「错的次数」：
 *   - contextWindow / maxOutputTokens 取最小：低估只是压缩提前（功能正常，且有手动
 *     contextWindow 兜底）；高估会把阈值算在不存在的空间上，导致模型直接拒绝请求的硬失败。
 *   - thinking 取「任一为真」：这是能力位，误判为 false 会永久钳掉 thinking 档位
 *     （正是 M4.5 立项要修的那个 bug）；实测 false 都是 16:1 这种极少数离群。
 * 「官方 vendor 优先」方案已被数据否掉：deepseek-chat 的 1000000 恰恰来自官方 provider
 * `deepseek` 自己，而真实是 128K —— 官方源同样会报错值，且该方案要维护映射表。
 */
describe('models.dev 多 vendor 同名冲突消解', () => {
  const MULTI = {
    vendorA: { models: { m1: { limit: { context: 200_000, output: 8_000 }, reasoning: true } } },
    vendorB: { models: { m1: { limit: { context: 1_000_000, output: 32_000 }, reasoning: false } } },
    vendorC: { models: { m1: { limit: { context: 204_800, output: 16_000 }, reasoning: true } } },
  };

  it('contextWindow 取最小（拒绝高估——高估会导致上下文超限硬失败）', async () => {
    const c = new ModelCatalog(cacheFile, fakeFetch(MULTI));
    expect(await c.refresh(true)).toBe(true);
    expect(c.getModelContextWindow('m1')).toBe(200_000);
  });

  it('thinking 取任一为真（少数 vendor 报 false 不得丢掉推理能力）', async () => {
    const c = new ModelCatalog(cacheFile, fakeFetch(MULTI));
    await c.refresh(true);
    expect(c.clampThinkingLevel('m1', 'high')).toBe('high');
  });

  it('末位 vendor 报 false 也不丢推理能力（回归 last-wins 的 63 例）', async () => {
    // 顺序刻意让「reasoning:false 且窗口最大」的 vendor 排在最后——last-wins 下两项都会错
    const worst = {
      good: { models: { m2: { limit: { context: 128_000, output: 8_000 }, reasoning: true } } },
      bad: { models: { m2: { limit: { context: 1_000_000, output: 64_000 }, reasoning: false } } },
    };
    const c = new ModelCatalog(cacheFile, fakeFetch(worst));
    await c.refresh(true);
    expect(c.getModelContextWindow('m2')).toBe(128_000);
    expect(c.clampThinkingLevel('m2', 'high')).toBe('high');
  });

  it('结果与 vendor 迭代顺序无关（消除 models.dev 重排导致的静默变化）', async () => {
    const entries = Object.entries(MULTI);
    const forward = new ModelCatalog(join(dir, 'f.json'), fakeFetch(Object.fromEntries(entries)));
    const reversed = new ModelCatalog(join(dir, 'r.json'), fakeFetch(Object.fromEntries([...entries].reverse())));
    await forward.refresh(true);
    await reversed.refresh(true);
    expect(forward.getModelContextWindow('m1')).toBe(reversed.getModelContextWindow('m1'));
    expect(forward.clampThinkingLevel('m1', 'high')).toBe(reversed.clampThinkingLevel('m1', 'high'));
  });

  it('缺 limit.context 的条目不参与取最小，也不覆盖已有值', async () => {
    const partial = {
      withWindow: { models: { m3: { limit: { context: 128_000, output: 8_000 }, reasoning: false } } },
      noWindow: { models: { m3: { reasoning: true } } }, // 无 limit
    };
    const c = new ModelCatalog(cacheFile, fakeFetch(partial));
    await c.refresh(true);
    expect(c.getModelContextWindow('m3')).toBe(128_000); // 不被 undefined 抹掉
    expect(c.clampThinkingLevel('m3', 'high')).toBe('high'); // 能力位仍取到 true
  });

  it('旧规则算出的缓存视为失效（否则修复要等 24h TTL 才生效）', async () => {
    // 模拟升级前留下的缓存：无 mergeRule 标记，且值是 last-wins 的高估值
    const { writeFileSync } = await import('node:fs');
    writeFileSync(cacheFile, JSON.stringify({
      fetchedAt: Date.now(), // 明确在 TTL 内——若不作废，refresh() 会跳过
      models: { m1: { contextWindow: 204_800, thinking: false } },
    }), 'utf8');
    const c = new ModelCatalog(cacheFile, fakeFetch(MULTI));
    expect(c.getModelContextWindow('m1')).toBeUndefined(); // 旧缓存未被采纳
    expect(await c.refresh()).toBe(true);                  // 非 force 也重拉（fetchedAt 已作废）
    expect(c.getModelContextWindow('m1')).toBe(200_000);   // 按新规则重算
  });

  it('带当前规则标记的缓存正常复用（不误伤新缓存）', async () => {
    const c1 = new ModelCatalog(cacheFile, fakeFetch(MULTI));
    await c1.refresh(true);
    const c2 = new ModelCatalog(cacheFile, async () => { throw new Error('不应发请求'); });
    expect(await c2.refresh()).toBe(false); // TTL 内跳过
    expect(c2.getModelContextWindow('m1')).toBe(200_000);
  });

  it('单 vendor 模型行为不变（不回归既有用例）', async () => {
    const c = new ModelCatalog(cacheFile, fakeFetch());
    await c.refresh(true);
    expect(c.getModelContextWindow('claude-sonnet-5')).toBe(200_000);
    expect(c.getModelContextWindow('gemini-2.5-flash')).toBe(1_048_576);
    expect(c.clampThinkingLevel('gpt-4o', 'high')).toBe('off'); // reasoning:false 单源仍为 false
  });
});

/**
 * M4.6 Task 1：佐证规则（A6）——取「被 ≥2 家 vendor 佐证过的值中的最小者」；
 * 全部值都只有一家报时退化为纯最小。计数单位 = 不同 provider 数。
 * 背景（复核方 2026-08-08 实时全量）：glm-5.1 有 18 家 vendor，8 家报 200000（含官方），
 * 仅 digitalocean 一家报 163840——纯最小被单离群拖到比官方低 18%。
 */
describe('M4.6 Task 1 佐证规则', () => {
  it('MERGE_RULE_VERSION 已递增到 2（作废按旧规则算出的缓存）', () => {
    expect(MERGE_RULE_VERSION).toBe(2);
  });

  it('单离群不拖垮：8 家报 200000 + 1 家报 163840 → 取被佐证的最小 200000', () => {
    const entries = [
      ...Array.from({ length: 8 }, () => ({ contextWindow: 200_000, maxOutputTokens: 64_000, thinking: true })),
      { contextWindow: 163_840, maxOutputTokens: 32_000, thinking: true }, // digitalocean 单离群
    ];
    expect(resolveModelsDevConflict(entries)).toMatchObject({ contextWindow: 200_000 });
  });

  it('全单例退化纯最小：每个值只有一家报 → 取全局最小（与现状一致）', () => {
    const entries = [
      { contextWindow: 200_000, maxOutputTokens: 64_000, thinking: true },
      { contextWindow: 1_000_000, maxOutputTokens: 32_000, thinking: false },
      { contextWindow: 128_000, maxOutputTokens: 16_000, thinking: true },
    ];
    expect(resolveModelsDevConflict(entries)).toMatchObject({ contextWindow: 128_000 });
  });

  it('结果与 vendor 迭代顺序无关（消除 models.dev 重排导致的静默变化）', () => {
    const entries = [
      { contextWindow: 200_000, maxOutputTokens: 64_000, thinking: true },
      { contextWindow: 1_000_000, maxOutputTokens: 32_000, thinking: false },
      { contextWindow: 200_000, maxOutputTokens: 64_000, thinking: true },
      { contextWindow: 163_840, maxOutputTokens: 32_000, thinking: true },
    ];
    const reversed = [...entries].reverse();
    expect(resolveModelsDevConflict(entries)).toEqual(resolveModelsDevConflict(reversed));
  });

  it('佐证值中仍取最小：多家 200000 + 多家 1047576 → 取 200000', () => {
    const entries = [
      ...Array.from({ length: 3 }, () => ({ contextWindow: 1_047_576, maxOutputTokens: 64_000, thinking: true })),
      ...Array.from({ length: 3 }, () => ({ contextWindow: 200_000, maxOutputTokens: 32_000, thinking: true })),
    ];
    expect(resolveModelsDevConflict(entries)).toMatchObject({ contextWindow: 200_000 });
  });

  it('maxOutputTokens 套用同规则（独立必要性：output 分歧 524 > 窗口分歧 452）', () => {
    const entries = [
      ...Array.from({ length: 3 }, () => ({ contextWindow: 128_000, maxOutputTokens: 64_000, thinking: true })),
      { contextWindow: 128_000, maxOutputTokens: 8_000, thinking: true }, // output 单离群
    ];
    expect(resolveModelsDevConflict(entries)).toMatchObject({
      contextWindow: 128_000, // 窗口单值多 vendor 佐证 → 128000
      maxOutputTokens: 64_000, // output 被佐证值 64000 胜出，单离群 8000 不拖垮
    });
  });

  it('thinking 任一为真不变（能力位不被"窗口最小那条漏标"影响）', () => {
    expect(resolveModelsDevConflict([
      { contextWindow: 200_000, maxOutputTokens: 64_000, thinking: false },
      { contextWindow: 1_000_000, maxOutputTokens: 32_000, thinking: true },
    ])).toMatchObject({ thinking: true });
  });

  it('经 ModelCatalog 集成：glm-5.1 场景假 fetch 取 200000（纯最小会取 163840）', async () => {
    const glmSources = {
      zhipuai: { models: { 'glm-5.1': { limit: { context: 200_000, output: 64_000 }, reasoning: true } } },
      zai: { models: { 'glm-5.1': { limit: { context: 200_000, output: 64_000 }, reasoning: true } } },
      digitalocean: { models: { 'glm-5.1': { limit: { context: 163_840, output: 32_000 }, reasoning: true } } },
      moonshot: { models: { 'glm-5.1': { limit: { context: 200_000, output: 64_000 }, reasoning: true } } },
    };
    const c = new ModelCatalog(cacheFile, fakeFetch(glmSources));
    expect(await c.refresh(true)).toBe(true);
    expect(c.getModelContextWindow('glm-5.1')).toBe(200_000);
  });
});
