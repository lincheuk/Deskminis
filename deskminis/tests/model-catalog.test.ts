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
