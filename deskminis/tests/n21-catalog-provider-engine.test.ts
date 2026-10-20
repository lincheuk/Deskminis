import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelCatalog } from '../src/minisd/providers/model-catalog';
import { accessMatrix, probeConnection, startAccessProbeEngine, startCapturedEngine, type CapturedEngine } from './engine-assembly';
import { GO_MODEL, GO_URL, n21CatalogFixture } from './n21-catalog-fixture';

let engine: CapturedEngine;
let apis: Readonly<Record<string, string>>;
const call = (method: string, params?: unknown) => engine.methods[method](params, probeConnection('local'));
const payload = { name: '合成OpenCode Go', kind: 'openai-compat', baseUrl: GO_URL, modelId: GO_MODEL, apiKey: 'synthetic-unused-key' };
beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), 'dm-n21-engine-'));
  const catalog = new ModelCatalog(join(root, 'models-dev-cache.json'), async () => new Response(JSON.stringify(n21CatalogFixture())));
  expect(await catalog.refresh(true)).toBe(true);
  apis = catalog.providerApiUrls();
  engine = await startCapturedEngine({ dataDir: root });
}, 60000);
afterAll(async () => { await engine?.close(); vi.restoreAllMocks(); });

describe('N21 真实引擎目录服务商RPC', () => {

  it('create/update写入providers.json，null清空，未带字段的更新保留原值', async () => {
    const created = await call('provider.instances.create', { ...payload, catalogProviderId: 'opencode-go' }) as any;
    const stored = () => JSON.parse(readFileSync(join(engine.root, 'providers.json'), 'utf8')).providers.find((p: any) => p.id === created.id);
    expect(stored().catalogProviderId).toBe('opencode-go');
    expect((await call('provider.runtime.resolve', { id: created.id }) as any).runtime.endpoint).toMatchObject({ class: 'catalog', catalogProviderId: 'opencode-go', manual: true });
    await call('provider.instances.update', { id: created.id, name: '仅改名' });
    expect(stored().catalogProviderId).toBe('opencode-go');
    await call('provider.instances.update', { id: created.id, catalogProviderId: null });
    expect(stored()).not.toHaveProperty('catalogProviderId');
    expect((await call('provider.runtime.resolve', { id: created.id }) as any).runtime.endpoint.class).toBe('relay');
    await call('provider.instances.update', { id: created.id, catalogProviderId: ' opencode-go ' });
    expect(stored().catalogProviderId).toBe('opencode-go');
    const draft = await call('provider.runtime.resolve', { kind: 'openai-compat', baseUrl: GO_URL, modelId: GO_MODEL, catalogProviderId: 'opencode-go' }) as any;
    expect(draft.runtime.endpoint.manual).toBe(true);
  });

  it.each([1, false, {}, [], '', ' ', 'x'.repeat(129)])('非法create/update %j 当场拒绝，文件逐字不变', async value => {
    const created = await call('provider.instances.create', payload) as any;
    const file = join(engine.root, 'providers.json'), before = readFileSync(file);
    await expect(Promise.resolve().then(() => call('provider.instances.create', { ...payload, catalogProviderId: value }))).rejects.toThrow('目录里的服务商必须是非空字符串');
    expect(readFileSync(file)).toEqual(before);
    await expect(Promise.resolve().then(() => call('provider.instances.update', { id: created.id, name: '不应写入', catalogProviderId: value }))).rejects.toThrow('目录里的服务商必须是非空字符串');
    expect(readFileSync(file)).toEqual(before);
  });

  it('新只读RPC按id排序，返回完整api，查询不写providers.json', async () => {
    const file = join(engine.root, 'providers.json'), before = readFileSync(file);
    const result = await call('provider.catalog.providers');
    expect(result).toStrictEqual({ providers: Object.keys(apis).sort().map(id => ({ id, api: apis[id] })) });
    expect((result as any).providers.some((p: any) => p.id === 'opencode-go')).toBe(true);
    expect(readFileSync(file)).toEqual(before);
  });

  it('访问快照来自真实登记：与catalog.get相同的local/pairing/remote权限', async () => {
    const fp = await engine.pair();
    await engine.handle.close();
    const probe = await startAccessProbeEngine({ dataDir: engine.root });
    try {
      const complete: string[] = [];
      const matrix = await accessMatrix({ 'provider.catalog.providers': probe.methods['provider.catalog.providers'] }, fp, complete);
      expect(matrix['provider.catalog.providers']).toEqual({ local: { allowed: true }, pairing: { allowed: false, error: 'provider.catalog.providers 在 pairing 模式下不可用（配对期仅可调 remote.pair.complete）' }, remote: { allowed: true } });
      expect(complete).toEqual([]);
      if (process.env.N21_CAPTURE_ACCESS) writeFileSync(process.env.N21_CAPTURE_ACCESS, JSON.stringify(matrix, null, 2) + '\n');
    } finally { await probe.close(); }
  }, 60000);
});
