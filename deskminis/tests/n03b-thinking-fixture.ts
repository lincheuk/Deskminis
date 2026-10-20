/** N03b 合成目录；地址仅供解析，不发网络请求。 */
import { catalogFixture, jsonResponse } from './runtime-model-fixture';
import { ModelCatalog } from '../src/minisd/providers/model-catalog';
import { decideThinking, resolveRuntimeModel, type RuntimeModelInput } from '../src/minisd/providers/runtime-model';
import { buildAnthropicBody, BINDING_MODELS } from '../src/minisd/providers/anthropic';
import { buildGeminiBody } from '../src/minisd/providers/gemini';
import { buildOpenAIBody } from '../src/minisd/providers/openai';
import type { StreamRequest } from '../src/minisd/providers/types';
import type { ThinkingLevel } from '../src/shared/types';

export const NEW_LEVELS = ['xhigh', 'max'] as const;
export function n03bCatalogFixture(api = 'https://n03b.example/v1'): Record<string, unknown> {
  const model = (values?: string[]) => ({
    limit: { context: 200_000, output: 96_000 }, reasoning: true, tool_call: true,
    modalities: { input: ['text'], output: ['text'] },
    ...(values ? { reasoning_options: [{ type: 'effort', values }] } : {}),
  });
  return {
    ...catalogFixture(),
    'n03b': { api, models: {
      'six': model(['low', 'medium', 'high', 'xhigh', 'max']),
      'three': model(['low', 'medium', 'high']),
      'sparse': model(['low', 'max']),
      'plain': model(),
      'toggle': { ...model(), reasoning_options: [{ type: 'toggle' }] },
      'empty': { ...model(), reasoning_options: [] },
      'low-medium': model(['low', 'medium']),
      'only-max': model(['max']),
      'budget': { ...model(), reasoning_options: [{ type: 'budget_tokens', min: 1024, max: 12_000 }] },
    } },
  };
}
export async function n03bCatalog(path: string, api?: string): Promise<ModelCatalog> {
  const cat = new ModelCatalog(path, async () => jsonResponse(n03bCatalogFixture(api)));
  await cat.refresh(true);
  return cat;
}

export function sampleRequest(level: ThinkingLevel, maxTokens = 96_000): StreamRequest {
  return {
    systemPrompt: '合成系统说明', maxTokens, thinkingLevel: level,
    messages: [{ role: 'user', parts: [{ type: 'text', value: '合成提问' }] }],
    tools: [{ name: 'sample', description: '测试工具', parameters: { text: { type: 'string', description: '正文' } }, required: ['text'] }],
  };
}

/** JSON 字符串是构建器发出的字段顺序与字节；基线在 bfd15c1 的改前源码上生成。 */
export function legacyBodies(cat: ModelCatalog): Record<string, string> {
  const rows: Record<string, string> = {};
  const cases: [string, RuntimeModelInput][] = [
    ['openai-six', { kind: 'openai-compat', modelId: 'six', baseUrl: 'https://n03b.example/v1' }],
    ['openai-three', { kind: 'openai-compat', modelId: 'three', baseUrl: 'https://n03b.example/v1' }],
    ['openai-plain', { kind: 'openai-compat', modelId: 'plain', baseUrl: 'https://n03b.example/v1' }],
    ['openai-manual', { kind: 'openai-compat', modelId: 'manual', baseUrl: 'https://relay.example/v1', capabilityOverrides: { reasoning: true } }],
    ['anthropic-budget', { kind: 'anthropic', modelId: 'claude-x' }],
    ['gemini-official', { kind: 'gemini', modelId: 'gem-v' }],
    ['gemini-manual', { kind: 'gemini', modelId: 'manual', capabilityOverrides: { reasoning: true } }],
    ...[...BINDING_MODELS].map(modelId => ['adaptive-' + modelId, { kind: 'anthropic', modelId }] as [string, RuntimeModelInput]),
  ];
  for (const level of ['off', 'low', 'medium', 'high'] as const) {
    for (const maxTokens of [2048, 96_000]) {
      for (const [name, input] of cases) {
        const rt = resolveRuntimeModel(input, cat);
        const plan = decideThinking(rt, level, maxTokens, '合成槽位');
        const req = { ...sampleRequest(plan.level, maxTokens), thinking: { effort: plan.effort, budgetTokens: plan.budgetTokens } };
        const body = rt.protocol === 'openai-chat' ? buildOpenAIBody(req, rt.modelId)
          : rt.protocol === 'gemini' ? buildGeminiBody(req, rt.modelId)
          : buildAnthropicBody(req, rt.modelId, { bindingControls: true });
        rows[`${name}/${level}/${maxTokens}`] = JSON.stringify(body);
      }
      rows[`direct-openai/${level}/${maxTokens}`] = JSON.stringify(buildOpenAIBody(sampleRequest(level, maxTokens), 'six'));
      rows[`direct-anthropic/${level}/${maxTokens}`] = JSON.stringify(buildAnthropicBody(sampleRequest(level, maxTokens), 'claude-x'));
      rows[`direct-gemini/${level}/${maxTokens}`] = JSON.stringify(buildGeminiBody(sampleRequest(level, maxTokens), 'gem-v'));
    }
  }
  return rows;
}
