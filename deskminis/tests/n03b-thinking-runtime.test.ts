import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideThinking, resolveRuntimeModel } from '../src/minisd/providers/runtime-model';
import { buildAnthropicBody, BINDING_MODELS } from '../src/minisd/providers/anthropic';
import { buildGeminiBody } from '../src/minisd/providers/gemini';
import type { ModelCatalog } from '../src/minisd/providers/model-catalog';
import { NEW_LEVELS, legacyBodies, n03bCatalog, sampleRequest } from './n03b-thinking-fixture';
import baseline from './fixtures/n03b-legacy-bodies.json';

let dir: string, cat: ModelCatalog;
beforeEach(async () => { dir = mkdtempSync(join(tmpdir(), 'dm-n03b-runtime-')); cat = await n03bCatalog(join(dir, 'catalog.json')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const openai = (modelId: string) => resolveRuntimeModel({ kind: 'openai-compat', modelId, baseUrl: 'https://n03b.example/v1' }, cat);

describe('N03b 请求计划与字节契约', () => {
  it('旧四档三家请求体与改前104份JSON字符串逐字节相同', () => {
    expect(legacyBodies(cat)).toEqual(baseline);
    expect(Object.keys(baseline)).toHaveLength(104);
  });

  for (const level of NEW_LEVELS) {
    it('仅声明同名档位才原样发送 ' + level, () => {
      expect(decideThinking(openai('six'), level, 96_000, '当前槽位')).toEqual({ level, effort: level });
      const mapped = decideThinking(openai('three'), level, 96_000, '当前槽位');
      expect(mapped.effort).toBe('high');
      expect(mapped.note).toContain(`推理档位 ${level} 改为 high`);
      expect(decideThinking(openai('sparse'), level, 96_000, '当前槽位').effort).toBe(level === 'max' ? 'max' : 'low');
    });

    it('未声明任何档位按高并提示 ' + level, () => {
      const manual = resolveRuntimeModel({ kind: 'openai-compat', modelId: 'manual', baseUrl: 'https://relay.example/v1', capabilityOverrides: { reasoning: true } }, cat);
      for (const rt of [manual, openai('plain')]) {
        expect(decideThinking(rt, level, 96_000, '当前槽位')).toEqual({ level: 'high', note: '当前槽位：当前端点没有声明这一档，本轮按 high 发送' });
      }
    });

    for (const kind of ['anthropic', 'gemini'] as const) {
      it('预算接入沿用高且有限数值 ' + kind + ' ' + level, () => {
        const rt = resolveRuntimeModel({ kind, modelId: kind === 'anthropic' ? 'claude-x' : 'gem-v' }, cat);
        for (const maxTokens of [2048, 96_000]) {
          const high = decideThinking(rt, 'high', maxTokens, '预算槽位');
          const plan = decideThinking(rt, level, maxTokens, '预算槽位');
          expect(plan.level).toBe('high');
          expect(plan.budgetTokens).toBe(high.budgetTokens);
          expect(Number.isFinite(plan.budgetTokens)).toBe(true);
          expect(plan.note).toContain('这个接入按推理预算控制，最多到高');
          // 无控制声明与显式预算区间的支路也必须沿用高。
          for (const control of [undefined, { budget: { min: 1024, max: 8192 } }]) {
            const budgetRt = { ...rt, reasoning: { ...rt.reasoning, control } };
            expect(decideThinking(budgetRt, level, maxTokens, '槽位').budgetTokens).toBe(decideThinking(budgetRt, 'high', maxTokens, '槽位').budgetTokens);
          }
        }
      });
    }

    it('直接绕过计划的两个构建器仍按高查表 ' + level, () => {
      for (const maxTokens of [2048, 96_000]) {
        const a = buildAnthropicBody(sampleRequest(level, maxTokens), 'claude-x');
        const g = buildGeminiBody(sampleRequest(level, maxTokens), 'gem-v') as any;
        expect(a.thinking).toEqual(buildAnthropicBody(sampleRequest('high', maxTokens), 'claude-x').thinking);
        expect(g.generationConfig.thinkingConfig).toEqual((buildGeminiBody(sampleRequest('high', maxTokens), 'gem-v') as any).generationConfig.thinkingConfig);
        expect(Number.isFinite((a.thinking as any).budget_tokens)).toBe(true);
        expect(Number.isFinite(g.generationConfig.thinkingConfig.thinkingBudget)).toBe(true);
        const req = { ...sampleRequest(level, maxTokens), thinking: { budgetTokens: 1234 } };
        expect(a).not.toEqual(buildAnthropicBody(req, 'claude-x'));
        expect((buildAnthropicBody(req, 'claude-x').thinking as any).budget_tokens).toBe(1234);
        expect((buildGeminiBody(req, 'gem-v') as any).generationConfig.thinkingConfig.thinkingBudget).toBe(1234);
      }
    });

    it('自适应三个型号在官方与中转仍与改前相同 ' + level, () => {
      for (const modelId of BINDING_MODELS) {
        for (const bindingControls of [true, false]) {
          expect(JSON.stringify(buildAnthropicBody(sampleRequest(level), modelId, { bindingControls }))).toBe(JSON.stringify(buildAnthropicBody(sampleRequest('high'), modelId, { bindingControls })));
        }
        const rt = resolveRuntimeModel({ kind: 'anthropic', modelId }, cat);
        expect(decideThinking(rt, level, 96_000, '自适应')).toEqual({ level });
      }
    });
  }

  for (const model of ['plain', 'toggle', 'empty', 'low-medium', 'three', 'six', 'only-max']) {
    it('补充12：未声明同名档位时与高完全相同 ' + model, () => {
      const rt = openai(model), high = decideThinking(rt, 'high', 96_000, '比较槽位');
      if (model === 'toggle') expect(high).toEqual({ level: 'off', note: '比较槽位 的推理参数是开关，当前接入只发送 reasoning_effort 档位，本轮未开启推理' });
      if (model === 'empty') expect(high).toEqual({ level: 'off', note: '比较槽位 的目录记录没有列出可调的推理参数，不另发推理参数' });
      for (const level of NEW_LEVELS) {
        const actual = decideThinking(rt, level, 96_000, '比较槽位');
        if (rt.reasoning.control?.efforts?.includes(level)) expect(actual).toEqual({ level, effort: level });
        else if (high.level === 'off') expect(actual).toEqual(high);
        else {
          const { note: highNote, ...highFields } = high;
          const { note, ...fields } = actual;
          expect(fields).toEqual(highFields);
          expect(note).toBeTruthy();
          if (highNote) expect(note).toContain(highNote);
          if (model === 'low-medium') expect(fields).toEqual({ level: 'high', effort: 'medium' });
          if (model === 'only-max') expect(fields).toEqual({ level: 'high', effort: 'max' });
        }
      }
    });
  }

  for (const input of [
    { kind: 'anthropic' as const, modelId: 'claude-x' },
    { kind: 'gemini' as const, modelId: 'gem-v' },
    { kind: 'gemini' as const, modelId: 'budget', baseUrl: 'https://n03b.example/v1' },
    { kind: 'gemini' as const, modelId: 'six', baseUrl: 'https://n03b.example/v1' },
  ]) {
    it('补充12：预算接入所有结果与高一致，关时保留原提示 ' + input.kind + input.modelId, () => {
      const rt = resolveRuntimeModel(input, cat);
      for (const maxTokens of [512, 2048, 96_000]) {
        for (const opts of [{}, { tightened: true, spaceLimited: true }]) {
          const high = decideThinking(rt, 'high', maxTokens, '预算比较', opts);
          for (const level of NEW_LEVELS) {
            const actual = decideThinking(rt, level, maxTokens, '预算比较', opts);
            if (high.level === 'off') expect(actual).toEqual(high);
            else {
              const { note: _highNote, ...highFields } = high;
              const { note, ...fields } = actual;
              expect(fields).toEqual(highFields);
              expect(note).toContain('这个接入按推理预算控制，最多到高');
            }
          }
        }
      }
    });
  }
});
