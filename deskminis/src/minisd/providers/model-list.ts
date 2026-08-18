import { ProviderError, type FetchLike } from './types';

export interface FetchModelListOpts {
  kind: 'anthropic' | 'openai-compat' | 'gemini' | 'ollama';
  baseUrl?: string;
  apiKey?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/** baseUrl 缺省值与 provider-store.ts instantiate() 的四个默认严格一致：
 *  两处各写一份会悄悄漂移——用户「获取列表」打到 A 端点、对话请求打到 B 端点。 */
const DEFAULT_BASE: Record<FetchModelListOpts['kind'], string> = {
  'openai-compat': 'https://api.openai.com/v1',
  ollama: 'http://localhost:11434/v1',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
};

/** 响应体积必须有界：目录型端点动辄上千条，全量透传会把 datalist 与 RPC 帧撑爆。 */
const MAX_MODELS = 2000;

/** 拉取端点的可用模型列表（设置页「获取列表」）。失败一律抛 ProviderError，
 *  由调用方决定静默回退；message 永不携带 apiKey（部分网关错误体会回显鉴权头）。 */
export async function fetchModelList(opts: FetchModelListOpts): Promise<string[]> {
  const base = (opts.baseUrl || DEFAULT_BASE[opts.kind]).replace(/\/$/, '');
  const apiKey = opts.apiKey ?? '';
  const fetchImpl = opts.fetchImpl ?? fetch;

  let url: string;
  let headers: Record<string, string>;
  switch (opts.kind) {
    case 'openai-compat':
    case 'ollama':
      url = `${base}/models`;
      // Ollama 等本地端点无 key：空 key 时整个头不发（部分前置代理对多余鉴权头 401，照抄 openai.ts 约定）
      headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
      break;
    case 'anthropic':
      url = `${base}/v1/models?limit=1000`;
      headers = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
      break;
    case 'gemini':
      url = `${base}/v1beta/models?pageSize=1000`;
      // 密钥放 header 而非 query key=：URL 会进代理/错误日志（照抄 gemini.ts 的理由）
      headers = { 'x-goog-api-key': apiKey };
      break;
  }

  let res: Response;
  try {
    // 目录刷新没有超时先例，但这里挂着 UI 按钮：不给上界的话一个挂死的端点会把按钮永远钉在「获取中」
    res = await fetchImpl(url, { method: 'GET', headers, signal: AbortSignal.timeout(opts.timeoutMs ?? 10000) });
  } catch (e) {
    // String(e) 理论上不含密钥（key 只进 header），仍统一抹一遍：错误 message 会一路透传到 RPC 响应
    const msg = apiKey ? String(e).split(apiKey).join('***') : String(e);
    throw new ProviderError(`模型列表网络错误: ${msg}`, { retryable: true });
  }
  if (!res.ok) {
    // 刻意不把响应体拼进 message：某些网关的 4xx 体里会原样回显 Authorization/x-api-key
    throw new ProviderError(`模型列表请求失败: HTTP ${res.status}`, { status: res.status });
  }

  let body: unknown;
  try { body = await res.json(); } catch { throw new ProviderError('模型列表响应不是合法 JSON'); }
  const b = body as Record<string, any>;
  // gemini 的数组在 models 字段且条目叫 name；其余两种（openai-compat/ollama 与 anthropic）都在 data[].id
  const raw = opts.kind === 'gemini' ? b?.models : b?.data;
  if (!Array.isArray(raw)) throw new ProviderError('模型列表响应缺少模型数组');

  const ids: string[] = [];
  for (const m of raw) {
    let id = (m as Record<string, unknown> | null)?.[opts.kind === 'gemini' ? 'name' : 'id'];
    if (opts.kind === 'gemini' && typeof id === 'string') id = id.replace(/^models\//, '');
    if (typeof id === 'string' && id) ids.push(id);
  }
  return [...new Set(ids)].sort((x, y) => x.localeCompare(y)).slice(0, MAX_MODELS);
}
