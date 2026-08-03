/**
 * M4.5 Task 7 · basellm 直连备源 测试
 *
 * 验证：models.dev 失败时自动回退 basellm 源；tags 字符串解析 K/M/小数窗口与 Reasoning；
 * 多 vendor 同名冲突按官方优先否则取最小值；双源皆失败静默降级 BUILTIN。
 * 单测禁外网——注入假 fetch。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ModelCatalog, parseTagsWindow, parseTagsThinking, resolveBasellmConflict } from '../src/minisd/providers/model-catalog';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string; let cacheFile: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dm-basellm-')); cacheFile = join(dir, 'models-dev-cache.json'); });

const BASELLM = {
  success: true,
  data: [
    { model_name: 'glm-5.1', vendor_name: 'Zhipu AI', tags: 'Reasoning,Tools,200K' },
    { model_name: 'glm-5.1', vendor_name: 'Z.AI', tags: 'Reasoning,Tools,200K' },
    { model_name: 'glm-5.1', vendor_name: '转售商A', tags: 'Reasoning,Tools,202.8K' },
    { model_name: 'glm-5.1', vendor_name: '转售商B', tags: 'Reasoning,Tools,204.8K' },
    { model_name: 'kimi-k2', vendor_name: 'Moonshot AI', tags: 'Reasoning,Tools,128K' },
    { model_name: 'no-window-model', vendor_name: 'Vendor X', tags: 'Tools,Vision' },
  ],
};

describe('parseTagsWindow', () => {
  it('K 后缀 → 千', () => {
    expect(parseTagsWindow('Reasoning,Tools,200K')).toBe(200_000);
  });
  it('小数 K → 精确到百', () => {
    expect(parseTagsWindow('Reasoning,Tools,Open Weights,202.8K')).toBe(202_800);
  });
  it('M 后缀 → 百万', () => {
    expect(parseTagsWindow('Tools,Files,Vision,2M')).toBe(2_000_000);
  });
  it('小数 M', () => {
    expect(parseTagsWindow('Tools,1.5M')).toBe(1_500_000);
  });
  it('无尺寸 token → undefined', () => {
    expect(parseTagsWindow('Tools,Vision')).toBeUndefined();
  });
  it('空 tags → undefined', () => {
    expect(parseTagsWindow('')).toBeUndefined();
  });
});

describe('parseTagsThinking', () => {
  it('含 Reasoning → true', () => {
    expect(parseTagsThinking('Reasoning,Tools,200K')).toBe(true);
  });
  it('不含 Reasoning → false', () => {
    expect(parseTagsThinking('Tools,Files,200K')).toBe(false);
  });
  it('大小写敏感（仅 Reasoning 大写触发）', () => {
    expect(parseTagsThinking('reasoning,Tools')).toBe(false);
  });
});

describe('resolveBasellmConflict', () => {
  it('官方 vendor 优先（glm → Zhipu AI/Z.AI）', () => {
    const entries = [
      { model_name: 'glm-5.1', vendor_name: 'Zhipu AI', tags: 'Reasoning,200K' },
      { model_name: 'glm-5.1', vendor_name: '转售商A', tags: 'Reasoning,202.8K' },
    ];
    expect(resolveBasellmConflict(entries, 'glm-5.1')?.contextWindow).toBe(200_000);
  });
  it('无官方 vendor → 取最小值', () => {
    const entries = [
      { model_name: 'mystery', vendor_name: 'A', tags: '200K' },
      { model_name: 'mystery', vendor_name: 'B', tags: '256K' },
      { model_name: 'mystery', vendor_name: 'C', tags: '128K' },
    ];
    expect(resolveBasellmConflict(entries, 'mystery')?.contextWindow).toBe(128_000);
  });
  it('官方与转售商并存 → 官方优先', () => {
    const entries = [
      { model_name: 'glm-5.1', vendor_name: '转售商', tags: '204.8K' },
      { model_name: 'glm-5.1', vendor_name: 'Zhipu AI', tags: '200K' },
      { model_name: 'glm-5.1', vendor_name: '转售商B', tags: '202.8K' },
    ];
    expect(resolveBasellmConflict(entries, 'glm-5.1')?.contextWindow).toBe(200_000);
  });
  it('kimi → Moonshot AI 官方', () => {
    const entries = [
      { model_name: 'kimi-k2', vendor_name: 'Moonshot AI', tags: 'Reasoning,128K' },
      { model_name: 'kimi-k2', vendor_name: '转售商', tags: 'Reasoning,200K' },
    ];
    expect(resolveBasellmConflict(entries, 'kimi-k2')?.contextWindow).toBe(128_000);
  });
});

describe('ModelCatalog 双源 refresh', () => {
  it('models.dev 失败 → 自动回退 basellm，且写入缓存（含 source 字段）', async () => {
    const calls: string[] = [];
    const c = new ModelCatalog(cacheFile, async (url: any) => {
      calls.push(String(url));
      if (String(url).includes('models.dev')) throw new Error('offline');
      return new Response(JSON.stringify(BASELLM), { status: 200 });
    });
    expect(await c.refresh(true)).toBe(true);
    expect(calls.length).toBe(2);                                  // 先 models.dev 后备源
    expect(c.getModelContextWindow('glm-5.1')).toBe(200_000);
    expect(c.clampThinkingLevel('glm-5.1', 'high')).toBe('high');  // 推理不再被钳 off
    // 缓存文件含 source 字段
    const cached = JSON.parse(readFileSync(cacheFile, 'utf8'));
    expect(cached.source).toBe('basellm');
  });

  it('models.dev 成功 → 不拉 basellm', async () => {
    const calls: string[] = [];
    const c = new ModelCatalog(cacheFile, async (url: any) => {
      calls.push(String(url));
      if (String(url).includes('models.dev')) {
        return new Response(JSON.stringify({
          anthropic: { models: { 'claude-sonnet-5': { limit: { context: 200000 }, reasoning: true } } },
        }), { status: 200 });
      }
      throw new Error('不应拉 basellm');
    });
    expect(await c.refresh(true)).toBe(true);
    expect(calls.length).toBe(1);
    const cached = JSON.parse(readFileSync(cacheFile, 'utf8'));
    expect(cached.source).toBe('models.dev');
  });

  it('双源皆失败 → 静默降级 BUILTIN，不抛错不阻塞', async () => {
    const c = new ModelCatalog(cacheFile, async () => { throw new Error('offline'); });
    expect(await c.refresh(true)).toBe(false);
    expect(c.getModelContextWindow('claude-future-9')).toBe(200_000); // BUILTIN 仍可用
    expect(existsSync(cacheFile)).toBe(false); // 双源皆失败不写缓存
  });

  it('basellm 返回 success:false → 视为失败', async () => {
    const c = new ModelCatalog(cacheFile, async (url: any) => {
      if (String(url).includes('models.dev')) throw new Error('offline');
      return new Response(JSON.stringify({ success: false, data: [] }), { status: 200 });
    });
    expect(await c.refresh(true)).toBe(false);
  });

  it('无窗口的模型条目不入表', async () => {
    const c = new ModelCatalog(cacheFile, async (url: any) => {
      if (String(url).includes('models.dev')) throw new Error('offline');
      return new Response(JSON.stringify(BASELLM), { status: 200 });
    });
    await c.refresh(true);
    expect(c.getModelContextWindow('no-window-model')).toBeUndefined();
  });

  it('多 vendor 同名冲突按官方优先消解（glm-5.1 → Zhipu AI 200K）', async () => {
    const c = new ModelCatalog(cacheFile, async (url: any) => {
      if (String(url).includes('models.dev')) throw new Error('offline');
      return new Response(JSON.stringify(BASELLM), { status: 200 });
    });
    await c.refresh(true);
    // 官方 Zhipu AI / Z.AI 均报 200K，转售商报 202.8K/204.8K → 取官方 200K
    expect(c.getModelContextWindow('glm-5.1')).toBe(200_000);
  });
});
