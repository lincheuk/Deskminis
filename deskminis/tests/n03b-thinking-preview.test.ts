import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCapturedEngine, probeConnection, type CapturedEngine } from './engine-assembly';
import { decideThinking } from '../src/minisd/providers/runtime-model';
import { BINDING_MODELS } from '../src/minisd/providers/anthropic';
import { n03bCatalog, NEW_LEVELS } from './n03b-thinking-fixture';

let engine: CapturedEngine | undefined;
afterEach(async () => { await engine?.close(); engine = undefined; });

describe('N03b 引擎只读thinkingPreview契约', () => {
  it('草稿各控制方式与保存实例均使用同一decideThinking及实际输出上限', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dm-n03b-preview-'));
    await n03bCatalog(join(dir, 'models-dev-cache.json'));
    engine = await startCapturedEngine({ dataDir: dir });
    const call = (m: string, p: any) => engine!.methods[m](p, probeConnection('local')) as Promise<any>;
    const cases = [
      ...['plain', 'toggle', 'empty', 'low-medium', 'three', 'six', 'only-max'].map(modelId => ({ kind: 'openai-compat', modelId, baseUrl: 'https://n03b.example/v1' })),
      { kind: 'openai-compat', modelId: 'manual', baseUrl: 'https://relay.example/v1', capabilityOverrides: { reasoning: true } },
      { kind: 'anthropic', modelId: 'claude-x' },
      { kind: 'gemini', modelId: 'gem-v' },
      { kind: 'gemini', modelId: 'budget', baseUrl: 'https://n03b.example/v1' },
      { kind: 'gemini', modelId: 'six', baseUrl: 'https://n03b.example/v1' },
      ...[...BINDING_MODELS].map(modelId => ({ kind: 'anthropic', modelId })),
    ];
    for (const input of cases) {
      const response = await call('provider.runtime.resolve', { ...input, name: '预告槽位', maxOutputTokens: 2048 });
      expect(Object.keys(response.thinkingPreview).sort()).toEqual(['max', 'xhigh']);
      expect(response.runtime.requestMaxTokens).toBe(2048);
      for (const level of NEW_LEVELS) {
        const expected = decideThinking(response.runtime, level, 2048, '预告槽位');
        expect(response.thinkingPreview[level]).toEqual({ ...expected, level: expected.effort ?? expected.level });
      }
      if (input.modelId === 'toggle' || input.modelId === 'empty') {
        expect(response.thinkingPreview.xhigh.level).toBe('off');
        expect(response.thinkingPreview.max.level).toBe('off');
      }
      if (input.modelId === 'low-medium') expect(response.thinkingPreview.xhigh.level).toBe('medium');
      if (input.modelId === 'claude-x' || input.modelId === 'gem-v' || input.modelId === 'budget') {
        expect(response.thinkingPreview.xhigh.budgetTokens).toBe(2047);
      }
    }
    const saved = await call('provider.instances.create', { name: '保存的预算槽位', kind: 'anthropic', modelId: 'claude-x', apiKey: 'synthetic', maxOutputTokens: 2048 });
    const response = await call('provider.runtime.resolve', { id: saved.id });
    expect(response.runtime.requestMaxTokens).toBe(2048);
    for (const level of NEW_LEVELS) {
      const plan = decideThinking(response.runtime, level, 2048, '保存的预算槽位');
      expect(response.thinkingPreview[level]).toEqual({ ...plan, level: plan.effort ?? plan.level });
    }
  }, 60000);
});
