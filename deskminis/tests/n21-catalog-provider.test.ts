import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelCatalog } from '../src/minisd/providers/model-catalog';
import { createModelMetadataMethods } from '../src/minisd/providers/model-metadata-rpc';
import { decideThinking, normalizeInstanceOverrides, parseOverrideInput, resolveRuntimeModel } from '../src/minisd/providers/runtime-model';
import { InMemoryVault, ProviderStore } from '../src/minisd/store/provider-store';
import baseline from './fixtures/n21-auto-runtime-baseline.json';
import { automaticCases, encodeRuntime, GO_MODEL, GO_URL, n21CatalogFixture, N21_NOW } from './n21-catalog-fixture';

let root: string;
let catalog: ModelCatalog;
const input = { kind: 'openai-compat' as const, baseUrl: GO_URL, modelId: GO_MODEL };
beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(N21_NOW);
  root = mkdtempSync(join(tmpdir(), 'dm-n21-runtime-'));
  catalog = new ModelCatalog(join(root, 'catalog.json'), async () => new Response(JSON.stringify(n21CatalogFixture())));
  expect(await catalog.refresh(true)).toBe(true);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('N21 目录服务商手动指定', () => {

  it.each(automaticCases.map((config, i) => ({ config, i })))('无手动字段：配置 $i 与c841356改前逐字段相同', ({ config, i }) => {
    expect(config).toStrictEqual(baseline.cases[i].input);
    expect(encodeRuntime(resolveRuntimeModel(config, catalog))).toStrictEqual(baseline.cases[i].expected);
  });

  it('OpenCode Go 地址不匹配仍未确认，指定后复用该服务商全部能力、价格与推理档位', () => {
    const auto = resolveRuntimeModel(input, catalog);
    expect(auto.endpoint).toStrictEqual({ class: 'relay', host: 'opencode.ai' });
    expect([auto.input.text.state, auto.output.text.state, auto.toolCall.state, auto.reasoning.state, auto.input.image.state]).toEqual(Array(5).fill('unknown'));
    const manual = resolveRuntimeModel({ ...input, catalogProviderId: 'opencode-go' }, catalog);
    expect(manual.endpoint).toStrictEqual({ class: 'catalog', host: 'opencode.ai', catalogProviderId: 'opencode-go', manual: true });
    expect(manual.overrides).toStrictEqual({ invalid: [], catalogProviderId: 'opencode-go' });
    for (const cap of [manual.input.text, manual.output.text, manual.toolCall, manual.reasoning]) expect(cap).toMatchObject({ state: 'supported', endpoint: 'confirmed', catalog: { source: 'endpoint', value: true } });
    expect(manual.input.image).toMatchObject({ state: 'unsupported', endpoint: 'confirmed', catalog: { source: 'endpoint', value: false } });
    expect(manual.reasoning.control?.efforts).toEqual(['low', 'medium', 'high', 'max']);
    expect(['low', 'medium', 'high'].map(level => decideThinking(manual, level as 'low' | 'medium' | 'high', 32_000, 'N21').effort)).toEqual(['low', 'medium', 'high']);
    expect(decideThinking(auto, 'high', 32_000, 'N21').level).toBe('off');
    expect(manual.price).toEqual(catalog.getEndpointRecord('opencode-go', GO_MODEL)?.price);
    expect(manual.price).toBeDefined();
  });

  it.each(['not-in-directory', 'constructor', '__proto__'])('目录没有 %s 时忽略手动项并列invalid', catalogProviderId => {
    const result = resolveRuntimeModel({ ...input, catalogProviderId }, catalog);
    expect(result.overrides.invalid.join(' ')).toContain('catalogProviderId');
    expect(result.overrides.invalid.join(' ')).toContain('当前目录没有');
    const auto = resolveRuntimeModel(input, catalog);
    expect({ ...result, overrides: { invalid: [] } }).toStrictEqual(auto);
  });

  it.each(['https://api.openai.com/v1', 'https://api.anthropic.com', 'https://generativelanguage.googleapis.com'])('官方端点 %s 不可被手动目录项改写', baseUrl => {
    const auto = resolveRuntimeModel({ ...input, baseUrl }, catalog);
    const result = resolveRuntimeModel({ ...input, baseUrl, catalogProviderId: 'opencode-go' }, catalog);
    expect(result.endpoint.class).toBe('official');
    expect(result.endpoint).not.toHaveProperty('manual');
    expect(result.overrides.invalid.join(' ')).toContain('官方端点不改');
    expect(result.overrides).not.toHaveProperty('catalogProviderId');
    expect({ ...result, overrides: { invalid: [] } }).toStrictEqual(auto);
  });

  it.each(['http://127.0.0.1:8080/v1', 'https://api.vendor-a.example/v1'])('本机或已收录地址 %s 也能手动指定', baseUrl => {
    const result = resolveRuntimeModel({ ...input, baseUrl, catalogProviderId: 'opencode-go' }, catalog);
    expect(result.endpoint).toEqual({ class: 'catalog', host: new URL(baseUrl).hostname, catalogProviderId: 'opencode-go', manual: true });
    expect(result.toolCall.state).toBe('supported');
  });

  it('离线目录忽略但不删配置，目录恢复后同一配置自动生效', async () => {
    const store = new ProviderStore(root, new InMemoryVault());
    const config = store.create({ ...input, name: '合成配置', catalogProviderId: 'opencode-go' });
    const file = join(root, 'providers.json'), original = readFileSync(file);
    const offline = new ModelCatalog(join(root, 'offline.json'), async () => { throw new Error('synthetic offline'); });
    expect(await offline.refresh(true)).toBe(false);
    expect(createModelMetadataMethods(offline)['provider.catalog.providers']()).toStrictEqual({ providers: [] });
    const before = resolveRuntimeModel(store.get(config.id)!, offline);
    expect(before.endpoint.class).toBe('relay');
    expect(before.overrides.invalid.join(' ')).toContain('当前目录没有');
    expect(readFileSync(file)).toEqual(original);
    const after = resolveRuntimeModel(store.get(config.id)!, catalog);
    expect(after.endpoint).toMatchObject({ class: 'catalog', manual: true, catalogProviderId: 'opencode-go' });
    expect(readFileSync(file)).toEqual(original);
  });

  it.each([42, false, {}, [], '', '   ', 'x'.repeat(129)])('手改非法值 %j 在读取时忽略，不改原文件', value => {
    const file = join(root, 'providers.json');
    writeFileSync(file, JSON.stringify({ providers: [{ id: 'P', name: '手改配置', ...input, catalogProviderId: value }] }));
    const bytes = readFileSync(file), config = new ProviderStore(root, new InMemoryVault()).get('P')!;
    const result = resolveRuntimeModel(config, catalog);
    expect(result.overrides.invalid.join(' ')).toContain('catalogProviderId');
    expect(result.endpoint).toEqual({ class: 'relay', host: 'opencode.ai' });
    expect(readFileSync(file)).toEqual(bytes);
  });

  it('null清空，合法id去空白，128字符可存，未知id不在写入阶段按目录拒绝', () => {
    expect(parseOverrideInput({ catalogProviderId: ' opencode-go ' }).catalogProviderId).toBe('opencode-go');
    expect(parseOverrideInput({ catalogProviderId: 'x'.repeat(128) }).catalogProviderId).toHaveLength(128);
    const cleared = parseOverrideInput({ catalogProviderId: null });
    expect(cleared.present.has('catalogProviderId')).toBe(true);
    expect(cleared.catalogProviderId).toBeUndefined();
    expect(normalizeInstanceOverrides({ catalogProviderId: null }, catalog.providerApiUrls())).toEqual({ invalid: [] });
  });
});
