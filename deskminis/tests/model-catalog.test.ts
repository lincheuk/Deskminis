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
