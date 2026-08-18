import { describe, it, expect } from 'vitest';
import { buildDisciplineBlock } from '../src/minisd/agent/model-discipline';

describe('buildDisciplineBlock 按模型族分派', () => {
  it('gpt/codex/grok 模型 → 注入 OpenAI 系纪律块（强调调工具）', () => {
    const r = buildDisciplineBlock('gpt-5', { toolUseEnforcement: true });
    expect(r).toContain('工具');
    expect(r.length).toBeGreaterThan(20);
  });

  it('gemini 模型 → 注入 Google 系纪律块', () => {
    const r = buildDisciplineBlock('gemini-2.5-pro', { toolUseEnforcement: true });
    expect(r).toContain('工具');
    expect(r).not.toContain('OpenAI'); // 不同块
  });

  it('claude 模型 → 注入 Anthropic 系纪律块', () => {
    const r = buildDisciplineBlock('claude-opus-4', { toolUseEnforcement: true });
    expect(r).toContain('工具');
  });

  it('未知模型 → 回落通用纪律块（与 OpenAI 系同文），不再返回空串', () => {
    // 返回空串等于对最常被用的国产/自建模型完全不设防；通用措辞对任何模型无害
    const r = buildDisciplineBlock('unknown-model', { toolUseEnforcement: true });
    expect(r).toBe(buildDisciplineBlock('gpt-5', { toolUseEnforcement: true }));
    expect(r.length).toBeGreaterThan(20);
  });

  it('qwen/deepseek/glm/kimi 等国产模型 → 命中纪律块', () => {
    for (const m of ['qwen3-max', 'deepseek-chat', 'glm-4.5', 'kimi-k2', 'minimax-m2', 'doubao-seed', 'hunyuan-turbo', 'ernie-4.5', 'moonshot-v1-auto']) {
      const r = buildDisciplineBlock(m, { toolUseEnforcement: true });
      expect(r).toContain('工具');
      expect(r.length).toBeGreaterThan(20);
    }
  });

  it('配置关闭 → 空纪律块', () => {
    expect(buildDisciplineBlock('gpt-5', { toolUseEnforcement: false })).toBe('');
  });

  it('grok 模型归入 OpenAI 系', () => {
    const r = buildDisciplineBlock('grok-4', { toolUseEnforcement: true });
    expect(r).toContain('工具');
  });

  it('降级切换 modelId → 纪律块跟着变', () => {
    // 由 system-prompt 的 stable 缓存失效保证（Task 2 已测），此处补单测
    const a = buildDisciplineBlock('gpt-5', { toolUseEnforcement: true });
    const b = buildDisciplineBlock('gemini-2.5-pro', { toolUseEnforcement: true });
    expect(a).not.toBe(b);
  });

  // tool_title 强制中文：国际模型冒烟观察到英文 title，纪律块三族都必须点名 tool_title 用中文
  it('tool_title 强制中文：OpenAI 系纪律块含 tool_title 与中文要求', () => {
    const r = buildDisciplineBlock('gpt-5', { toolUseEnforcement: true });
    expect(r).toContain('tool_title');
    expect(r).toContain('中文');
  });

  it('tool_title 强制中文：Google 系纪律块含 tool_title 与中文要求', () => {
    const r = buildDisciplineBlock('gemini-2.5-pro', { toolUseEnforcement: true });
    expect(r).toContain('tool_title');
    expect(r).toContain('中文');
  });

  it('tool_title 强制中文：Anthropic 系纪律块含 tool_title 与中文要求', () => {
    const r = buildDisciplineBlock('claude-opus-4', { toolUseEnforcement: true });
    expect(r).toContain('tool_title');
    expect(r).toContain('中文');
  });
});
