/** G1 awesome-dsh-plugin 适配器（社区层第三源，设计稿 §2）。
 *  端点照 2026-08-20 实抓（g1-probe-run.txt）：GitHub Pages 静态索引 GET /plugins.json
 *  （1.28MB < 列表 2MB 上限；带真 ETag，304 条件请求验证通过）——单一整文件索引，无按需查询。
 *  kind 过滤（分类映射，实抓裁定）：
 *  - category 'skill'（67 条）→ kind 'skill' 入列；
 *  - 其余全丢：'theme'（71）是 DSH 外观主题；'tools'/'ui'/'model'/'session'/'memory'/'browser'/
 *    'vision'/'voice'/'docs'/'workflow'/'git'/'notify'/'dev'/'security'/'remote'/'market'/'fun'/
 *    'usage' 是 DSH **代码插件**——装不进 DeskMinis（DSH 插件本体 ≠ 技能/MCP），
 *    即便描述里提及 MCP（如 MCP 面板插件）也不是 MCP server，同样丢弃；
 *  - 索引无 MCP 服务器类目 → kind 'mcp' 恒空。
 *  一律 verdict='unscanned'（无上游扫描）、tier='community'（社区 awesome 清单，设计 §1-4b）。
 *  搜索是本地过滤（索引整文件已缓存）：名称/双语描述不区分大小写。 */
import type { MarketCache } from './cache';
import type { MarketItem, MarketPage, MarketSource, MarketDetail } from './types';

const INDEX_URL = 'https://awesome-dsh-plugin.com/plugins.json';
const INDEX_KEY = 'awesome-dsh:index';
const LIST_TTL_MS = 15 * 60 * 1000; // 索引整文件缓存 15 分钟（ETag 条件重取）
const LIST_MAX_BYTES = 2 * 1024 * 1024;

/** 实抓字段（节选）：name/owner/url/page/category/description{en,zh}/npm/stars/downloads/install/added。 */
interface AwesomePlugin {
  name?: string;
  owner?: string;
  category?: string;
  description?: { en?: string; zh?: string };
  stars?: number;
  downloads?: number;
}

interface AwesomeIndex {
  plugins?: AwesomePlugin[];
}

function pluginToItem(p: AwesomePlugin): MarketItem {
  const name = p.name ?? '';
  const owner = p.owner ?? '';
  return {
    id: `awesome-dsh:${owner}/${name}`,
    kind: 'skill',
    name,
    author: owner,
    description: p.description?.en ?? p.description?.zh ?? '',
    stats: { downloads: p.downloads ?? 0, stars: p.stars ?? 0 },
    verdict: 'unscanned',
    sourceTier: 'community',
    category: p.category,
    raw: p,
  };
}

export class AwesomeDshSource implements MarketSource {
  readonly id = 'awesome-dsh';
  readonly name = 'awesome-dsh-plugin';
  readonly tier = 'community' as const;
  readonly kinds = ['skill'] as const;

  constructor(private readonly cache: MarketCache) {}

  /** 拉索引（走缓存：未过期零网络；过期 ETag 条件请求；故障降级 stale）。 */
  private async fetchIndex(): Promise<{ plugins: AwesomePlugin[]; stale: boolean }> {
    const entry = await this.cache.getText(INDEX_KEY, INDEX_URL, {
      maxBytes: LIST_MAX_BYTES, ttlMs: LIST_TTL_MS,
    });
    try {
      const idx = JSON.parse(entry.body) as AwesomeIndex;
      return { plugins: Array.isArray(idx.plugins) ? idx.plugins : [], stale: entry.stale };
    } catch (e) {
      // 降级拿到的坏缓存按空索引处理不了就抛——但更常见的是上游 200 坏 JSON，直接响亮。
      throw new Error(`awesome-dsh 索引解析失败: ${e instanceof Error ? e.message : e}`);
    }
  }

  async search(q: string, kind: string, cursor?: string, limit?: number): Promise<MarketPage> {
    // 索引无 MCP 服务器类目（2026-08-20 实抓裁定）→ kind=mcp 恒空且不发请求。
    if (kind !== 'skill') return { items: [] };
    const offset = cursor === undefined || cursor === '' ? 0 : parseOffset(cursor);
    const pageSize = limit ?? 30;

    const { plugins, stale } = await this.fetchIndex();
    // kind 过滤：只有 skill 分类入列（映射理由见文件头注释）。
    let pool = plugins.filter((p) => p.category === 'skill');
    // 本地搜索：名称 + 双语描述，不区分大小写（索引是静态文件，无上游搜索能力）。
    if (q !== '') {
      const needle = q.toLowerCase();
      pool = pool.filter((p) => {
        const hay = [p.name ?? '', p.description?.en ?? '', p.description?.zh ?? '']
          .join('\n').toLowerCase();
        return hay.includes(needle);
      });
    }
    const items = pool.map(pluginToItem).slice(offset, offset + pageSize);
    const next = offset + items.length;
    const page: MarketPage = { items };
    if (next < pool.length) page.cursor = String(next); // 无上游游标 → 本地偏移切页
    if (stale) page.stale = true;
    return page;
  }

  async detail(id: string): Promise<MarketDetail> {
    // id 是全形态 awesome-dsh:{owner}/{name}（适配器统一接口：自剥本源前缀）。
    // 详情数据就在索引里（无独立详情端点）。
    const m = /^awesome-dsh:([^/]+)\/(.+)$/.exec(id);
    if (!m) throw new Error(`非法 awesome-dsh 条目 id: ${id}`);
    const [, owner, name] = m;

    const { plugins, stale } = await this.fetchIndex();
    const p = plugins.find((x) => x.owner === owner && x.name === name);
    if (!p) throw new Error(`awesome-dsh 索引中无此条目: ${id}`);

    // README 由双语描述汇合（静态索引的全部说明文字就这些）。
    const readme = [p.description?.en, p.description?.zh].filter(Boolean).join('\n\n');
    return { item: pluginToItem(p), readme, stale: stale || undefined };
  }
}

function parseOffset(cursor: string): number {
  if (!/^\d+$/.test(cursor)) throw new Error(`非法分页游标: ${cursor}`);
  return Number(cursor);
}
