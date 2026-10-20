/** N21：只用于测试的目录与配置，不请求示例地址。 */
import { catalogFixtureF01R } from './runtime-model-fixture';
import type { RuntimeModelInput } from '../src/minisd/providers/runtime-model';

export const N21_NOW = 1_792_130_000_000;
export const GO_URL = 'https://opencode.ai/zen/go/v1';
export const GO_API = 'https://opencode.ai/inference/go/v1';
export const GO_MODEL = 'cat-jam-free';
export function n21CatalogFixture(): Record<string, unknown> {
  return {
    ...catalogFixtureF01R(),
    'opencode-go': { id: 'opencode-go', api: GO_API, models: {
      [GO_MODEL]: { name: 'Cat Jam', limit: { context: 200_000, output: 32_000 }, tool_call: true, reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high', 'max'] }],
        modalities: { input: ['text'], output: ['text'] }, cost: { input: 0.2, output: 0.5 } },
    } },
    'opencode-z': { id: 'opencode-z', api: 'https://opencode.ai/other/v1', models: {} },
    'aaa-other': { id: 'aaa-other', api: 'https://other.example/v1', models: {} },
  };
}

export const automaticCases: RuntimeModelInput[] = [
  { kind: 'anthropic', modelId: 'claude-x' },
  { kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', modelId: 'claude-opus-5-5' },
  { kind: 'gemini', modelId: 'gem-v' },
  { kind: 'openai-compat', baseUrl: 'https://api.openai.com/v1', modelId: 'gpt-text' },
  { id: 'A', name: '甲', kind: 'openai-compat', baseUrl: 'https://api.vendor-a.example/v1', modelId: 'shared-model' },
  { kind: 'openai-compat', baseUrl: 'https://api.vendor-b.example/openai/v1/chat', modelId: 'shared-model' },
  { kind: 'openai-compat', baseUrl: 'https://opencode.ai/inference/go/v1', modelId: GO_MODEL },
  { kind: 'openai-compat', baseUrl: GO_URL, modelId: GO_MODEL },
  { kind: 'openai-compat', baseUrl: 'https://relay.example/v1', modelId: 'shared-model' },
  { kind: 'openai-compat', baseUrl: 'https://tie.example/v1', modelId: 'tie-model' },
  { kind: 'ollama', modelId: GO_MODEL },
  { kind: 'openai-compat', baseUrl: 'http://127.0.0.1:8080/v1', modelId: GO_MODEL },
  { kind: 'openai-compat', baseUrl: 'http://[::1]:8080/v1', modelId: 'shared-model' },
  { kind: 'openai-compat', baseUrl: 'not a url', modelId: 'not-in-catalog' },
  { kind: 'openai-compat', baseUrl: 'https://relay.example/v1', modelId: 'shared-model', contextWindow: 150_000, maxOutputTokens: 12_000, capabilityOverrides: { imageInput: false, reasoning: true } },
];

/** 保存显式undefined键，避免JSON快照把“缺键”与“有键且undefined”混成一样。 */
export function encodeRuntime(value: unknown): unknown {
  if (value === undefined) return { __n21Undefined: true };
  if (Array.isArray(value)) return value.map(encodeRuntime);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encodeRuntime(v)]));
  return value;
}
