import type { ToolExecutor } from './types';

export type SearchProviderKind = 'brave' | 'tavily' | 'searxng';

/** 已解析的搜索配置（minisd 内部消费形态）。密钥只进请求头，绝不进输出/日志/RPC 响应。 */
export interface ResolvedSearchProvider { kind: SearchProviderKind; apiKey?: string; baseUrl?: string }

/** 单次搜索硬超时：搜索是增强能力而非关键路径，15 秒无响应就把控制权还给模型。 */
const DEFAULT_TIMEOUT_MS = 15000;
/** 每条摘要上限（码点）：结果列表是索引不是正文，摘要够模型决定要不要 web_fetch 读全文。 */
const SNIPPET_MAX_CP = 500;
/** 总输出上限（码点）：与 web_fetch 的 100KB 同理，防止超长结果灌爆上下文。 */
const OUTPUT_MAX_CP = 32 * 1024;

/** count 夹取到 1..10；缺省/非数回 5（schema 只约束 integer，越界值在这里兜底）。 */
function clampCount(raw: unknown): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return 5;
  return Math.min(10, Math.max(1, n));
}

/** 码点安全截断：slice 按 UTF-16 码元会把 emoji（代理对）切成半个，落进提示词就是乱码
 *  （同 offload.ts 摘录的码点安全模式）。 */
function truncateCp(s: string, max: number): string {
  const cps = Array.from(s);
  return cps.length <= max ? s : cps.slice(0, max).join('');
}

interface SearchResultItem { title: string; url: string; snippet: string }

/** 宽容映射：单条缺 title/url/摘要就跳过该条——搜索结果是索引，缺字段的条目对模型没有
 *  可用价值；不能因一条坏数据让整次搜索失败。数组形态不对按无结果处理。 */
function pickItems(arr: unknown, descKey: 'description' | 'content'): SearchResultItem[] {
  if (!Array.isArray(arr)) return [];
  const out: SearchResultItem[] = [];
  for (const r of arr) {
    if (typeof r !== 'object' || r === null) continue;
    const title = (r as Record<string, unknown>).title;
    const url = (r as Record<string, unknown>).url;
    const desc = (r as Record<string, unknown>)[descKey];
    if (typeof title !== 'string' || !title.trim()) continue;
    if (typeof url !== 'string' || !url.trim()) continue;
    if (typeof desc !== 'string' || !desc.trim()) continue;
    out.push({ title: title.trim(), url: url.trim(), snippet: truncateCp(desc.trim(), SNIPPET_MAX_CP) });
  }
  return out;
}

/** 配置是否可发起请求：brave/tavily 缺密钥、searxng 缺实例地址都视同未配置
 *  （脏配置不能带出半截请求——密钥不存在时请求必然 401，不如直接引导用户去设置）。 */
function isUsable(conf: ResolvedSearchProvider | undefined): conf is ResolvedSearchProvider {
  if (!conf) return false;
  if (conf.kind === 'searxng') return Boolean(conf.baseUrl);
  return Boolean(conf.apiKey);
}

/** web_search 工具：按设置里配置的搜索 provider（brave/tavily/searxng）联网搜索。
 *  getConfig 返回 minisd 内部解析的配置（含密钥）；fetchImpl 构造注入（测试路由假 fetch，仓库惯例）。 */
export function makeWebSearchTool(
  getConfig: () => ResolvedSearchProvider | undefined,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): ToolExecutor {
  return {
    definition: {
      name: 'web_search',
      description: '联网搜索公开网络（brave/tavily/searxng，按设置配置）。需要最新资讯、时效性事实或本地知识覆盖不到的内容时使用；返回编号结果列表（标题/URL/摘要），可用 web_fetch 打开具体结果读全文。',
      parameters: {
        query: { type: 'string', description: '搜索关键词' },
        count: { type: 'integer', description: '结果条数，1-10，默认 5' },
        tool_title: { type: 'string', description: '这次调用的 5-10 字中文摘要，如「网络搜索」' },
      },
      required: ['query', 'tool_title'],
    },
    async execute(input, ctx) {
      // 已取消（用户点了停止）：立即收场，不再发配置检查、权限询问、网络请求
      if (ctx.signal?.aborted) return { output: '[已取消]', success: false };
      const query = String(input.query ?? '').trim();
      if (!query) return { output: '搜索关键词不能为空', success: false };

      // 未配置检查先于权限卡：没有配置就没有数据会离开本机，弹卡只会打断用户后立刻失败
      const conf = getConfig();
      if (!isUsable(conf)) {
        return { output: '未配置搜索服务：请到设置的网络搜索分区选择 provider 并填写密钥或实例地址', success: false };
      }

      // 查询串本身就是数据外泄通道（论证同 web-fetch 的 URL 查询串），默认档 askOnce 过卡
      const decision = await ctx.permissions.check({ kind: 'web-search', detail: query, sessionId: ctx.sessionId, toolTitle: String(input.tool_title) });
      if (decision === 'deny') return { output: '搜索被用户拒绝（可在设置-权限中调整）', success: false };
      // 权限等待可长达 90 秒，已 abort 的 signal 不补发事件，闸后必须重查
      if (ctx.signal?.aborted) return { output: '[已取消]', success: false };

      const count = clampCount(input.count);
      let url: string;
      let init: RequestInit;
      if (conf.kind === 'brave') {
        // 密钥只进请求头：URL 会出现在权限卡/日志/工具输出里，绝不能携带凭据
        const u = new URL('https://api.search.brave.com/res/v1/web/search');
        u.searchParams.set('q', query);
        u.searchParams.set('count', String(count));
        url = u.href;
        init = { headers: { 'X-Subscription-Token': conf.apiKey!, 'Accept': 'application/json' } };
      } else if (conf.kind === 'tavily') {
        url = 'https://api.tavily.com/search';
        init = {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${conf.apiKey!}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, max_results: count }),
        };
      } else {
        // 尾斜杠规范化：用户填不填 / 都拼出唯一确定的 <base>/search，带不带斜杠行为一致
        const base = conf.baseUrl!.replace(/\/+$/, '');
        try {
          const u = new URL(`${base}/search`);
          u.searchParams.set('q', query);
          u.searchParams.set('format', 'json'); // searxng 默认 HTML 输出，JSON 要显式要
          url = u.href;
        } catch {
          return { output: 'SearXNG 实例地址无效，请到设置检查搜索配置', success: false };
        }
        init = {};
      }

      const signals = [AbortSignal.timeout(timeoutMs), ctx.signal].filter((s): s is AbortSignal => Boolean(s));
      let res: Response;
      try {
        res = await fetchImpl(url, { ...init, signal: AbortSignal.any(signals) });
      } catch (e) {
        // 会话取消优先于超时归类（AbortError 两种来源都有，先看 signal 再看名字）
        if (ctx.signal?.aborted) return { output: '[已取消]', success: false };
        const name = (e as Error)?.name ?? '';
        if (name === 'TimeoutError' || name === 'AbortError') return { output: `搜索请求超时（${Math.round(timeoutMs / 1000)} 秒）`, success: false };
        return { output: `搜索请求失败: ${(e as Error)?.message ?? String(e)}`, success: false };
      }

      // 非 2xx 文案只含状态码，不读响应体：错误页可能回显请求信息（含密钥），密钥绝不进输出
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          return { output: `搜索 API 密钥无效或无权限（HTTP ${res.status}），请到设置检查搜索配置`, success: false };
        }
        if (res.status === 429) return { output: '搜索服务限流，请稍后再试', success: false };
        return { output: `搜索服务暂不可用（HTTP ${res.status}）`, success: false };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(await res.text());
      } catch {
        return { output: '搜索服务响应无法解析', success: false };
      }
      if (typeof parsed !== 'object' || parsed === null) return { output: '搜索服务响应无法解析', success: false };
      const obj = parsed as Record<string, unknown>;
      const items = conf.kind === 'brave'
        ? pickItems(typeof obj.web === 'object' && obj.web !== null ? (obj.web as Record<string, unknown>).results : undefined, 'description')
        : pickItems(obj.results, 'content');

      if (items.length === 0) return { output: '无搜索结果', success: true };
      const lines: string[] = [];
      items.forEach((it, i) => {
        lines.push(`${i + 1}. ${it.title}`, `   URL: ${it.url}`, `   摘要: ${it.snippet}`);
      });
      lines.push('', '可用 web_fetch 打开具体结果读取全文。');
      let output = lines.join('\n');
      const cps = Array.from(output);
      if (cps.length > OUTPUT_MAX_CP) output = cps.slice(0, OUTPUT_MAX_CP).join('') + '\n[输出超过 32KB 被截断]';
      return { output, success: true };
    },
  };
}
