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

  it('未知模型 → 空纪律块（不注入）', () => {
    expect(buildDisciplineBlock('unknown-model', { toolUseEnforcement: true })).toBe('');
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
});
