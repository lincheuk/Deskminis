/** G1 MCP 官方注册表适配器（MCP 目录全量底座，设计稿 §2）。
 *  端点与字段照 2026-08-20 实抓（g1-probe-run.txt）：
 *  - 列表 GET /v0.1/servers?search=&limit=&cursor=（cursor 分页，metadata.nextCursor 透传）；
 *  - 详情 GET /v0.1/servers/{name URL 编码}/versions/latest（name 是反向 DNS，含 '/'，必须
 *    encodeURIComponent——否则路径段被拆散 404）。
 *  sourceTier=community：注册表宽进提交（仅命名空间归属验证，无人工审核），调研 §3。
 *  verdict 一律 unscanned：注册表无扫描裁定（调研 §3「宽进审核」）。 */
import type { MarketCache } from './cache';
import type { MarketItem, MarketPage, MarketSource, MarketDetail } from './types';

const BASE = 'https://registry.modelcontextprotocol.io';

const LIST_TTL_MS = 15 * 60 * 1000;
const DETAIL_TTL_MS = 24 * 60 * 60 * 1000;
const LIST_MAX_BYTES = 2 * 1024 * 1024;
const DETAIL_MAX_BYTES = 512 * 1024;

/** 实抓字段（节选）：servers[].server.{name, title, description, version, remotes[]} +
 *  metadata.nextCursor。 */
interface RegistryListBody {
  servers?: Array<{ server?: RegistryServerEntry }>;
  metadata?: { nextCursor?: string | null };
}

interface RegistryServerEntry {
  name?: string;
  title?: string;
  description?: string;
  version?: string;
}

/** 反向 DNS 名的命名空间即发布者线索：io.github.owner/mcp-fetch → io.github.owner。 */
function authorOf(name: string): string {
  const idx = name.lastIndexOf('/');
  return idx > 0 ? name.slice(0, idx) : name;
}

function toNamepacedId(name: string): string {
  return `mcp-registry:${name}`;
}

function entryToItem(s: RegistryServerEntry): MarketItem {
  const name = s.name ?? '';
  return {
    id: toNamepacedId(name),
    kind: 'mcp',
    name: s.title ?? name, // title 优先：反向 DNS 名是机器名，title 才是给人看的
    author: authorOf(name),
    description: s.description ?? '',
    stats: { downloads: 0, stars: 0 }, // v0.1 frozen schema 无热度字段，不编造
    verdict: 'unscanned',
    sourceTier: 'community',
    raw: s,
  };
}

export class McpRegistrySource implements MarketSource {
  readonly id = 'mcp-registry';
  readonly name = 'MCP 官方注册表';
  readonly tier = 'community' as const;
  readonly kinds = ['mcp'] as const;

  constructor(private readonly cache: MarketCache) {}

  async search(q: string, kind: string, cursor?: string, limit?: number): Promise<MarketPage> {
    if (kind !== 'mcp') return { items: [] };
    const pageSize = limit ?? 30;

    // 上游有真游标（metadata.nextCursor）→ 透传，不做本地切页。
    // 缓存键带上 q/limit/cursor：不同页是不同 URL，混用会拿错页。
    const key = `mcp-registry:list:${q}:${pageSize}:${cursor ?? ''}`;
    const params = new URLSearchParams({ limit: String(pageSize) });
    if (q !== '') params.set('search', q); // 查询串只含功能参数
    if (cursor !== undefined && cursor !== '') params.set('cursor', cursor);
    const url = `${BASE}/v0.1/servers?${params.toString()}`;

    const entry = await this.cache.getText(key, url, { maxBytes: LIST_MAX_BYTES, ttlMs: LIST_TTL_MS });

    let body: RegistryListBody;
    try {
      body = JSON.parse(entry.body) as RegistryListBody;
    } catch (e) {
      throw new Error(`mcp-registry 列表响应解析失败: ${e instanceof Error ? e.message : e}`);
    }
    const items = (body.servers ?? [])
      .filter((e) => typeof e.server?.name === 'string' && e.server.name !== '')
      .map((e) => entryToItem(e.server!));
    const page: MarketPage = { items };
    // 上游游标原样透传给调用方（聚合层再汇成自己的聚合游标）。
    const next = body.metadata?.nextCursor;
    if (next) page.cursor = next;
    if (entry.stale) page.stale = true;
    return page;
  }

  async detail(id: string, opts?: { ttlMs?: number }): Promise<MarketDetail> {
    // id 是全形态 mcp-registry:{反向 DNS 名}（适配器统一接口：自剥本源前缀）。
    // detail 是定点查询：失败要响亮（404 直接抛）。
    // opts.ttlMs（G4）：checkUpdates 传 0 强制条件请求（新版本不被 24h 详情缓存挡住）。
    if (!id.startsWith('mcp-registry:') || id === 'mcp-registry:') throw new Error(`非法 mcp-registry 条目 id: ${id}`);
    const name = id.slice('mcp-registry:'.length);
    const key = `mcp-registry:detail:${name}`;
    const url = `${BASE}/v0.1/servers/${encodeURIComponent(name)}/versions/latest`;
    const entry = await this.cache.getText(key, url, {
      maxBytes: DETAIL_MAX_BYTES, ttlMs: opts?.ttlMs ?? DETAIL_TTL_MS,
    });

    let body: { server?: RegistryServerEntry };
    try {
      body = JSON.parse(entry.body) as { server?: RegistryServerEntry };
    } catch (e) {
      throw new Error(`mcp-registry 详情响应解析失败（${id}）: ${e instanceof Error ? e.message : e}`);
    }
    const s = body.server ?? {};
    return {
      item: entryToItem({ ...s, name: s.name ?? name }), // 详情响应可能缺 name（实抓有；缺则用条目名补）
      readme: s.description ?? '', // 注册表无 README，description 即全部说明文字
      stale: entry.stale || undefined,
      latestVersion: s.version ?? undefined, // G4：server.version 即注册表内最新版本串
    };
  }
}
