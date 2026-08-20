/** G1 ClawHub 适配器（技能市场主源，设计稿 §2）：search / detail / scan 裁定。
 *  端点与字段照 2026-08-20 实抓（g1-probe-run.txt）：
 *  - 搜索 GET /api/v1/search?q=&limit=&nonSuspiciousOnly=true（相关性搜索，无游标 → 本地切页）；
 *  - 详情 GET /api/v1/skills/{slug}?ownerHandle={owner}（裸 slug 会 409 AMBIGUOUS_SKILL_SLUG，必须消歧），
 *    skill.description 即 SKILL.md 全文（含 frontmatter）→ README；
 *  - 安全裁定 GET /api/v1/skills/{slug}/scan?ownerHandle={owner}，security.status ∈ clean/suspicious/malicious。
 *  sourceTier 一律 community：平台机器扫描≠官方背书（ClawHavoc 教训，调研 §4）。 */
import type { MarketCache } from './cache';
import type { MarketItem, MarketPage, MarketSource, MarketDetail } from './types';

const BASE = 'https://clawhub.ai';

/** 一次取数窗口：上游无游标，翻页靠本地偏移切这份缓存结果（60 覆盖前几页足够，
 *  再深的长尾翻页在市场场景可接受重新取）。不随调用方页大小变——保证同 q 命中同一条缓存。 */
const SEARCH_FETCH_LIMIT = 60;
/** 列表 TTL 15 分钟 / 详情与 scan 24h（设计稿 §2 软过期档位）。 */
const LIST_TTL_MS = 15 * 60 * 1000;
const DETAIL_TTL_MS = 24 * 60 * 60 * 1000;
/** 列表 2MB / 详情（含 README 全文）512KB（设计稿 §2 预算上限）。 */
const LIST_MAX_BYTES = 2 * 1024 * 1024;
const DETAIL_MAX_BYTES = 512 * 1024;

/** 实抓字段（节选）：slug/displayName/summary/downloads/ownerHandle/isSuspicious +
 *  native.skill.{isSuspicious, stats.{downloads, stars}}。 */
interface ClawHubSearchResult {
  slug?: string;
  displayName?: string;
  summary?: string;
  downloads?: number;
  ownerHandle?: string;
  isSuspicious?: boolean;
  native?: { skill?: { isSuspicious?: boolean; stats?: { downloads?: number; stars?: number } } };
}

interface ClawHubDetailBody {
  skill?: {
    slug?: string;
    displayName?: string;
    summary?: string;
    description?: string;
    stats?: { downloads?: number; stars?: number };
  };
  owner?: { handle?: string };
}

interface ClawHubScanBody {
  security?: { status?: string };
}

/** scan security.status → verdict。未扫/未知一律 unscanned——消费端不猜。 */
function verdictFromScan(scan: ClawHubScanBody | undefined): MarketItem['verdict'] {
  switch (scan?.security?.status) {
    case 'clean': return 'ok';
    case 'suspicious': return 'warn';
    case 'malicious': return 'malicious';
    default: return 'unscanned';
  }
}

function searchResultToItem(r: ClawHubSearchResult): MarketItem {
  const owner = r.ownerHandle ?? '';
  const slug = r.slug ?? '';
  // 顶层 isSuspicious 与 native.skill.isSuspicious 都看：实抓两处都存在，任一可疑即 warn。
  const suspicious = r.native?.skill?.isSuspicious ?? r.isSuspicious ?? false;
  return {
    id: `clawhub:${owner}/${slug}`,
    kind: 'skill',
    name: r.displayName ?? slug,
    author: owner,
    description: r.summary ?? '',
    stats: {
      downloads: r.native?.skill?.stats?.downloads ?? r.downloads ?? 0,
      stars: r.native?.skill?.stats?.stars ?? 0,
    },
    // 列表态无扫描裁定（nonSuspiciousOnly 也只是过滤参数）：真实裁定在 detail 的 scan。
    verdict: suspicious ? 'warn' : 'unscanned',
    sourceTier: 'community',
    raw: r,
  };
}

export class ClawHubSource implements MarketSource {
  readonly id = 'clawhub';
  readonly name = 'ClawHub';
  readonly tier = 'community' as const;
  readonly kinds = ['skill'] as const;

  constructor(private readonly cache: MarketCache) {}

  async search(q: string, kind: string, cursor?: string, limit?: number): Promise<MarketPage> {
    // 本源只服务技能；不发请求（kind 路由在聚合层，但适配器自己也拦一道）。
    if (kind !== 'skill') return { items: [] };
    // 空 q 短路：上游是相关性搜索，空 q 本就返回空——省一次网络往返。
    if (q === '') return { items: [] };
    const offset = parseOffset(cursor);
    const pageSize = limit ?? 30;

    const key = `clawhub:search:${q}`;
    // 查询串只含功能参数（q/limit/nonSuspiciousOnly）——「URL 查询串即外泄通道」纪律。
    const url = `${BASE}/api/v1/search?q=${encodeURIComponent(q)}&limit=${SEARCH_FETCH_LIMIT}&nonSuspiciousOnly=true`;
    const entry = await this.cache.getText(key, url, { maxBytes: LIST_MAX_BYTES, ttlMs: LIST_TTL_MS });

    let results: ClawHubSearchResult[] = [];
    try {
      const body = JSON.parse(entry.body) as { results?: ClawHubSearchResult[] };
      results = Array.isArray(body.results) ? body.results : [];
    } catch {
      // 缓存里竟有坏 JSON（或降级的坏数据）：当作空结果处理比抛错好——列表是浏览面不是定点查询。
      results = [];
    }
    const items = results.map(searchResultToItem).slice(offset, offset + pageSize);
    const next = offset + items.length;
    const page: MarketPage = { items };
    if (next < results.length) page.cursor = String(next); // 上游无游标 → 本地偏移切页
    if (entry.stale) page.stale = true;
    return page;
  }

  async detail(id: string): Promise<MarketDetail> {
    // id 是全形态 clawhub:{ownerHandle}/{slug}（适配器统一接口：detail 收归一 id，自剥本源前缀）
    // ——ownerHandle 是详情/scan 端点的消歧必参数（裸 slug 会 409）。
    const m = /^clawhub:([^/]+)\/(.+)$/.exec(id);
    if (!m) throw new Error(`非法 clawhub 条目 id: ${id}`);
    const [, owner, slug] = m;

    const detailKey = `clawhub:detail:${owner}/${slug}`;
    const detailUrl = `${BASE}/api/v1/skills/${encodeURIComponent(slug)}?ownerHandle=${encodeURIComponent(owner)}`;
    const detailEntry = await this.cache.getText(detailKey, detailUrl, {
      maxBytes: DETAIL_MAX_BYTES, ttlMs: DETAIL_TTL_MS,
    });
    let body: ClawHubDetailBody;
    try {
      body = JSON.parse(detailEntry.body) as ClawHubDetailBody;
    } catch (e) {
      throw new Error(`clawhub 详情响应解析失败（${id}）: ${e instanceof Error ? e.message : e}`);
    }
    const skill = body.skill ?? {};

    // scan 是详情的富化而非前置：失败/缺失 → unscanned，不拖垮详情（读侧不该被扫描端点拖死）。
    let scan: ClawHubScanBody | undefined;
    try {
      const scanKey = `clawhub:scan:${owner}/${slug}`;
      const scanUrl = `${BASE}/api/v1/skills/${encodeURIComponent(slug)}/scan?ownerHandle=${encodeURIComponent(owner)}`;
      const scanEntry = await this.cache.getText(scanKey, scanUrl, {
        maxBytes: DETAIL_MAX_BYTES, ttlMs: DETAIL_TTL_MS,
      });
      scan = JSON.parse(scanEntry.body) as ClawHubScanBody;
    } catch {
      scan = undefined; // 无缓存且上游故障 → 如实降级 unscanned，由确认卡灰字提示
    }

    const readme = skill.description ?? skill.summary ?? '';
    const item: MarketItem = {
      id: `clawhub:${owner}/${slug}`,
      kind: 'skill',
      name: skill.displayName ?? slug,
      author: body.owner?.handle ?? owner,
      description: skill.summary ?? '',
      stats: {
        downloads: skill.stats?.downloads ?? 0,
        stars: skill.stats?.stars ?? 0,
      },
      verdict: verdictFromScan(scan),
      sourceTier: 'community',
      raw: body,
    };
    return { item, readme, stale: detailEntry.stale || undefined };
  }
}

/** 本地偏移游标：纯数字。坏游标响亮报错（比静默回到第一页好——分页错位更难查）。 */
function parseOffset(cursor: string | undefined): number {
  if (cursor === undefined || cursor === '') return 0;
  if (!/^\d+$/.test(cursor)) throw new Error(`非法分页游标: ${cursor}`);
  return Number(cursor);
}
