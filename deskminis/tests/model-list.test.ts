/** fetchModelList：设置页「获取列表」的端点模型拉取。
 *  fakeFetch 记录 url 与 init.headers，断言四种 kind 的最终 URL、鉴权头与解析结果
 *  （注入模式参照 model-catalog.test.ts）。 */
import { describe, it, expect } from 'vitest';
import { fetchModelList } from '../src/minisd/providers/model-list';
import { ProviderError } from '../src/minisd/providers/types';

interface Rec { url?: string; headers?: Record<string, string> }

function recFetch(payload: unknown, rec: Rec = {}, status = 200) {
  return async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    rec.url = String(url);
    rec.headers = (init?.headers ?? {}) as Record<string, string>;
    return new Response(JSON.stringify(payload), { status });
  };
}

describe('fetchModelList 按 kind 分派', () => {
  it('openai-compat：GET {base}/models + Bearer 头，解析 data[].id', async () => {
    const rec: Rec = {};
    const models = await fetchModelList({
      kind: 'openai-compat', baseUrl: 'https://relay.example/v1', apiKey: 'sk-oc',
      fetchImpl: recFetch({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] }, rec),
    });
    expect(rec.url).toBe('https://relay.example/v1/models');
    expect(rec.headers!['authorization']).toBe('Bearer sk-oc');
    expect(models).toEqual(['gpt-4o', 'gpt-4o-mini']);
  });

  it('openai-compat 空 key：整个 authorization 头不发（照抄 openai.ts 约定）', async () => {
    const rec: Rec = {};
    await fetchModelList({ kind: 'openai-compat', baseUrl: 'http://x/v1', apiKey: '', fetchImpl: recFetch({ data: [] }, rec) });
    expect('authorization' in rec.headers!).toBe(false);
  });

  it('ollama：默认 base http://localhost:11434/v1 → GET /v1/models', async () => {
    const rec: Rec = {};
    const models = await fetchModelList({
      kind: 'ollama', fetchImpl: recFetch({ data: [{ id: 'qwen3' }] }, rec),
    });
    expect(rec.url).toBe('http://localhost:11434/v1/models');
    expect(models).toEqual(['qwen3']);
  });

  it('anthropic：默认端点 GET /v1/models?limit=1000 + x-api-key + anthropic-version', async () => {
    const rec: Rec = {};
    const models = await fetchModelList({
      kind: 'anthropic', apiKey: 'ak-1', fetchImpl: recFetch({ data: [{ id: 'claude-sonnet-5' }] }, rec),
    });
    expect(rec.url).toBe('https://api.anthropic.com/v1/models?limit=1000');
    expect(rec.headers!['x-api-key']).toBe('ak-1');
    expect(rec.headers!['anthropic-version']).toBe('2023-06-01');
    expect(models).toEqual(['claude-sonnet-5']);
  });

  it('gemini：GET /v1beta/models?pageSize=1000，key 只在 x-goog-api-key 头、不在 URL；剥 models/ 前缀', async () => {
    const rec: Rec = {};
    const models = await fetchModelList({
      kind: 'gemini', apiKey: 'gk-1',
      fetchImpl: recFetch({ models: [{ name: 'models/gemini-2.5-flash' }, { name: 'models/gemini-2.5-pro' }] }, rec),
    });
    expect(rec.url).toBe('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000');
    expect(rec.headers!['x-goog-api-key']).toBe('gk-1');
    expect(rec.url).not.toContain('gk-1'); // URL 会进代理与错误日志
    expect(models).toEqual(['gemini-2.5-flash', 'gemini-2.5-pro']);
  });

  it('尾斜杠 baseUrl 归一（与三家 provider 构造器同式）', async () => {
    const rec: Rec = {};
    await fetchModelList({ kind: 'openai-compat', baseUrl: 'https://x.example/v1/', apiKey: 'k', fetchImpl: recFetch({ data: [] }, rec) });
    expect(rec.url).toBe('https://x.example/v1/models');
  });
});

describe('fetchModelList 失败语义', () => {
  it('非 2xx → ProviderError 带 status，message 不含 apiKey（部分网关会在错误体里回显鉴权头）', async () => {
    const rec: Rec = {};
    await expect(fetchModelList({
      kind: 'openai-compat', baseUrl: 'http://x/v1', apiKey: 'sk-leak',
      fetchImpl: recFetch({ error: { message: 'invalid sk-leak' } }, rec, 401),
    })).rejects.toSatisfy((e: unknown) => {
      expect(e).toBeInstanceOf(ProviderError);
      expect((e as ProviderError).status).toBe(401);
      expect((e as Error).message).not.toContain('sk-leak');
      return true;
    });
  });

  it('网络错误（fetch 抛出）→ ProviderError', async () => {
    await expect(fetchModelList({
      kind: 'anthropic', apiKey: 'k',
      fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    })).rejects.toBeInstanceOf(ProviderError);
  });

  it('响应解析不出模型数组 → ProviderError', async () => {
    await expect(fetchModelList({
      kind: 'openai-compat', baseUrl: 'http://x/v1', apiKey: 'k',
      fetchImpl: async () => new Response('{"oops":1}', { status: 200 }),
    })).rejects.toBeInstanceOf(ProviderError);
  });

  it('超时：AbortSignal.timeout 触发 abort 后 fetch reject → ProviderError（挂着 UI 按钮必须有界）', async () => {
    const hang: typeof fetch = (url, init) => new Promise<Response>((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(new Error('The operation was aborted due to timeout')));
    });
    await expect(fetchModelList({
      kind: 'openai-compat', baseUrl: 'http://x/v1', apiKey: 'k', fetchImpl: hang, timeoutMs: 20,
    })).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('fetchModelList 结果清洗', () => {
  it('去重 + localeCompare 排序', async () => {
    const models = await fetchModelList({
      kind: 'openai-compat', baseUrl: 'http://x/v1', apiKey: 'k',
      fetchImpl: recFetch({ data: [{ id: 'zeta' }, { id: 'alpha' }, { id: 'zeta' }, { id: '' }, { id: 42 }, {}] }),
    });
    expect(models).toEqual(['alpha', 'zeta']); // 空串与非 string 全部剔除
  });

  it('硬上限 2000 条（响应体积必须有界）', async () => {
    const big = Array.from({ length: 2500 }, (_, i) => ({ id: `m-${String(i).padStart(4, '0')}` }));
    const models = await fetchModelList({
      kind: 'openai-compat', baseUrl: 'http://x/v1', apiKey: 'k',
      fetchImpl: recFetch({ data: big }),
    });
    expect(models).toHaveLength(2000);
  });
});
